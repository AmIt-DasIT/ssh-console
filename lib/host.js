'use strict';

const { shq, checkImage, parseJsonLines } = require('./util');

const SKIP_FS = /^(tmpfs|devtmpfs|overlay|shm|udev|none|efivarfs|map |devfs)/;
const SKIP_MOUNT = /^\/(proc|sys|run|dev|snap|var\/lib\/docker|System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware))(\/|$)/;

/** One round-trip that collects basic system facts. Works on Linux; degrades gracefully elsewhere. */
async function hostInfo(session) {
  const script = [
    'echo @@uname; uname -srm',
    'echo @@os; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || (sw_vers -productName 2>/dev/null && sw_vers -productVersion 2>/dev/null)',
    'echo @@uptime; cat /proc/uptime 2>/dev/null || sysctl -n kern.boottime 2>/dev/null',
    'echo @@load; cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null',
    'echo @@cpus; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null',
    'echo @@mem; grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo 2>/dev/null',
    'echo @@disk; df -P -k 2>/dev/null',
  ].join('; ');

  const [sys, info, df] = await Promise.allSettled([
    session.exec(`sh -c ${shq(script)}`, { timeout: 15000 }),
    session.exec(`${session.docker} info --format '{{json .}}'`, { timeout: 20000 }),
    session.exec(`${session.docker} system df --format '{{json .}}'`, { timeout: 30000 }),
  ]);

  const out = { system: {}, docker: null, dockerDf: [] };

  if (sys.status === 'fulfilled') {
    const sections = {};
    let cur = null;
    for (const line of sys.value.stdout.split('\n')) {
      const m = /^@@(\w+)$/.exec(line);
      if (m) { cur = m[1]; sections[cur] = []; } else if (cur && line.trim()) sections[cur].push(line);
    }
    const s = out.system;
    s.kernel = (sections.uname || [])[0] || '';
    s.os = (sections.os || []).join(' ');
    const up = (sections.uptime || [])[0] || '';
    const boot = /sec = (\d+)/.exec(up); // macOS: { sec = 1700000000, usec = 0 }
    s.uptimeSec = boot ? Math.floor(Date.now() / 1000) - Number(boot[1]) : parseFloat(up) || null;
    const load = ((sections.load || [])[0] || '').replace(/[{}]/g, '').trim().split(/\s+/);
    s.load = load.slice(0, 3).map(Number).filter((n) => !Number.isNaN(n));
    s.cpus = parseInt((sections.cpus || [])[0], 10) || null;
    const mem = {};
    for (const l of sections.mem || []) {
      const m = /^(\w+):\s+(\d+)/.exec(l);
      if (m) mem[m[1]] = Number(m[2]) * 1024;
    }
    if (mem.MemTotal) {
      s.memTotal = mem.MemTotal;
      s.memAvailable = mem.MemAvailable;
      s.swapTotal = mem.SwapTotal;
      s.swapFree = mem.SwapFree;
    }
    s.disks = (sections.disk || [])
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 6)
      .map((p) => ({ fs: p[0], size: Number(p[1]) * 1024, used: Number(p[2]) * 1024, avail: Number(p[3]) * 1024, mount: p.slice(5).join(' ') }))
      .filter((d) => d.size > 0 && !SKIP_FS.test(d.fs) && !SKIP_MOUNT.test(d.mount) && !/^\/dev\/loop/.test(d.fs));
  }

  if (info.status === 'fulfilled' && info.value.code === 0) {
    try {
      const i = JSON.parse(info.value.stdout);
      out.docker = {
        version: i.ServerVersion,
        os: i.OperatingSystem,
        kernel: i.KernelVersion,
        arch: i.Architecture,
        cpus: i.NCPU,
        memTotal: i.MemTotal,
        containers: i.Containers,
        running: i.ContainersRunning,
        paused: i.ContainersPaused,
        stopped: i.ContainersStopped,
        images: i.Images,
        driver: i.Driver,
        rootDir: i.DockerRootDir,
        loggingDriver: i.LoggingDriver,
        cgroup: i.CgroupVersion,
        swarm: i.Swarm && i.Swarm.LocalNodeState,
        warnings: i.Warnings || [],
      };
    } catch { /* ignore */ }
  }
  if (df.status === 'fulfilled' && df.value.code === 0) out.dockerDf = parseJsonLines(df.value.stdout);
  return out;
}

const images = (s) => s.docker$(`images --no-trunc --format '{{json .}}'`).then(parseJsonLines);
const volumes = (s) => s.docker$(`volume ls --format '{{json .}}'`).then(parseJsonLines);
const networks = (s) => s.docker$(`network ls --no-trunc --format '{{json .}}'`).then(parseJsonLines);
const statsAll = (s) => s.docker$(`stats --no-stream --format '{{json .}}'`, 30000).then(parseJsonLines);

async function imageRemove(s, m) {
  return s.docker$(`rmi ${shq(checkImage(m.ref))}`, 120000);
}

async function imagePrune(s, m) {
  return s.docker$(`image prune -f${m.all ? ' -a' : ''}`, 300000);
}

module.exports = { hostInfo, images, volumes, networks, statsAll, imageRemove, imagePrune };
