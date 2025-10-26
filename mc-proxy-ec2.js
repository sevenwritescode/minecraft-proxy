/**
 * proxy.js
 *
 * - Friendly disconnect mode using minecraft-protocol (online-mode:true).
 * - Whitelist stored in whitelist.json (UUIDs).
 * - Per-IP token-bucket rate limiter + failure counters + temporary bans.
 * - Admin HTTP API (token-protected) for whitelist management and manual start/stop/status.
 *
 * Env variables:
 *   INSTANCE_ID         - EC2 instance id (i-...)
 *   AWS_REGION          - AWS region (default us-east-1)
 *   PROXY_PORT          - Minecraft port to listen on (default 25565)
 *   TARGET_PORT         - Backend Minecraft port (default 25565)
 *   MC_VERSION          - Minecraft protocol version (e.g. 1.20.2)
 *   SHUTDOWN_IDLE_MINUTES - minutes before stopping EC2 when empty (default 10)
 *   ADMIN_TOKEN         - secret token for admin HTTP API
 *
 * Run:
 *   INSTANCE_ID=i-... AWS_REGION=us-east-1 ADMIN_TOKEN=secret node proxy.js
 */

const fs = require('fs').promises;
const path = require('path');
const net = require('net');
const mc = require('minecraft-protocol');
const fetch = require('node-fetch');
const express = require('express');
const bodyParser = require('body-parser');
const {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand
} = require('@aws-sdk/client-ec2');

const WHITELIST_FILE = path.resolve(__dirname, 'whitelist.json');

const INSTANCE_ID = process.env.INSTANCE_ID;
const REGION = process.env.AWS_REGION || 'us-east-1';
const PROXY_PORT = Number(process.env.PROXY_PORT || 25565);
const TARGET_PORT = Number(process.env.TARGET_PORT || 25565);
const MC_VERSION = process.env.MC_VERSION || '1.20.2';
const SHUTDOWN_IDLE_MINUTES = Number(process.env.SHUTDOWN_IDLE_MINUTES || 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

if (!INSTANCE_ID) {
  console.error("Please set INSTANCE_ID env var.");
  process.exit(1);
}
if (!ADMIN_TOKEN) {
  console.error("Please set ADMIN_TOKEN env var for admin HTTP API.");
  process.exit(1);
}

const ec2 = new EC2Client({ region: REGION });

/* ---------- Whitelist management (file-backed) ---------- */
let whitelistSet = new Set();

async function loadWhitelist() {
  try {
    const raw = await fs.readFile(WHITELIST_FILE, 'utf8');
    const arr = JSON.parse(raw);
    whitelistSet = new Set((arr || []).map(u => (u || '').toLowerCase()));
    console.log('Whitelist loaded:', whitelistSet.size, 'entries');
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fs.writeFile(WHITELIST_FILE, JSON.stringify([]), 'utf8');
      whitelistSet = new Set();
      console.log('Created empty whitelist.json');
    } else {
      console.error('Failed to load whitelist:', err);
    }
  }
}
async function saveWhitelist() {
  const arr = Array.from(whitelistSet);
  await fs.writeFile(WHITELIST_FILE, JSON.stringify(arr, null, 2), 'utf8');
}
function addWhitelist(uuid) { whitelistSet.add(uuid.toLowerCase()); return true; }
function removeWhitelist(uuid) { return whitelistSet.delete(uuid.toLowerCase()); }
function isWhitelisted(uuid) { return whitelistSet.has((uuid||'').toLowerCase()); }

/* ---------- Rate limiter & ban logic ---------- */
// Token bucket per IP
const ipBuckets = new Map();
// Config
const TOKEN_REFILL_INTERVAL_MS = 15 * 1000; // refill 1 token every 15s
const TOKENS_PER_REFILL = 1;
const MAX_TOKENS = 3; // burst
const START_ALLOWED_TOKENS = 1; // tokens at connection start

// Failure counters & temp ban
const failCounts = new Map(); // ip -> {count, firstFailTs}
const BAN_MAP = new Map(); // ip -> unbanTs
const FAIL_MAX = 5; // fails within window triggers temp ban
const FAIL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const BAN_DURATION_MS = 30 * 60 * 1000; // 30 minutes

function ensureBucket(ip) {
  if (!ipBuckets.has(ip)) {
    ipBuckets.set(ip, { tokens: START_ALLOWED_TOKENS, lastRefill: Date.now() });
  }
}
function refillBucket(ip) {
  const b = ipBuckets.get(ip);
  if (!b) return;
  const now = Date.now();
  const elapsed = now - b.lastRefill;
  const steps = Math.floor(elapsed / TOKEN_REFILL_INTERVAL_MS);
  if (steps > 0) {
    b.tokens = Math.min(MAX_TOKENS, b.tokens + steps * TOKENS_PER_REFILL);
    b.lastRefill += steps * TOKEN_REFILL_INTERVAL_MS;
  }
}
function consumeToken(ip) {
  ensureBucket(ip);
  refillBucket(ip);
  const b = ipBuckets.get(ip);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return true;
  }
  return false;
}
function recordFail(ip) {
  const now = Date.now();
  const st = failCounts.get(ip) || { count: 0, firstFailTs: now };
  if (now - st.firstFailTs > FAIL_WINDOW_MS) {
    // reset window
    st.count = 1;
    st.firstFailTs = now;
  } else {
    st.count++;
  }
  failCounts.set(ip, st);
  if (st.count >= FAIL_MAX) {
    BAN_MAP.set(ip, Date.now() + BAN_DURATION_MS);
    console.log('Banned IP', ip, 'for', BAN_DURATION_MS/60000, 'minutes due to repeated fails');
    // reset failCounts for this ip
    failCounts.delete(ip);
  }
}
function isBanned(ip) {
  const ts = BAN_MAP.get(ip);
  if (!ts) return false;
  if (Date.now() > ts) {
    BAN_MAP.delete(ip);
    return false;
  }
  return true;
}

/* ---------- Proxy mode & EC2 control ---------- */
let mcServer = null;
let tcpServer = null;
let backendHost = null;
let backendReady = false;
let activeSockets = new Set();
let shutdownTimer = null;
let starting = false;
let lastStartRequest = 0;
const START_DEBOUNCE_MS = 30_000;

async function describeInstance() {
  const cmd = new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] });
  const resp = await ec2.send(cmd);
  const inst = resp.Reservations?.[0]?.Instances?.[0] || null;
  return inst;
}

async function startInstance() {
  const now = Date.now();
  if (now - lastStartRequest < START_DEBOUNCE_MS) return;
  lastStartRequest = now;
  try {
    const inst = await describeInstance();
    const state = inst?.State?.Name;
    if (state === 'running' || state === 'pending') {
      console.log('Instance already', state);
      pollForIpAndReady(); // ensure we pick up IP if running
      return;
    }
    console.log('Starting instance', INSTANCE_ID);
    starting = true;
    await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
    pollForIpAndReady();
  } catch (err) {
    console.error('startInstance error:', err);
  }
}

async function stopInstance() {
  try {
    const inst = await describeInstance();
    const state = inst?.State?.Name;
    if (state !== 'running') {
      console.log('Instance not running; skip stop (state=', state, ')');
      return;
    }
    console.log('Stopping instance', INSTANCE_ID);
    await ec2.send(new StopInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  } catch (err) {
    console.error('stopInstance error:', err);
  } finally {
    backendHost = null;
    backendReady = false;
    switchToFriendlyMode();
  }
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function checkTcpOpen(host, port, timeout = 2000) {
  return new Promise(resolve => {
    const s = net.createConnection({ host, port, timeout }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function pollForIpAndReady() {
  // wait until PublicIpAddress exists and port is reachable
  const deadline = Date.now() + 6 * 60_000; // 6 minutes max
  while (Date.now() < deadline) {
    try {
      const inst = await describeInstance();
      const state = inst?.State?.Name;
      const ip = inst?.PublicIpAddress || null;
      console.log('Instance state:', state, 'publicIp:', ip);
      if (state === 'running' && ip) {
        const open = await checkTcpOpen(ip, TARGET_PORT, 2000);
        if (open) {
          backendHost = ip;
          backendReady = true;
          starting = false;
          console.log('Backend reachable at', ip, TARGET_PORT);
          switchToTcpForwardMode(ip);
          return;
        } else {
          console.log('Backend port not open yet at ip', ip);
        }
      }
    } catch (err) {
      console.error('pollForIpAndReady error', err);
    }
    await sleep(3000);
  }
  console.error('Timeout waiting for backend to become reachable.');
  starting = false;
}

/* ---------- Friendly Minecraft server - online-mode ---------- */
function startMinecraftFriendlyServer() {
  if (mcServer) return;
  console.log('Starting friendly Minecraft server on port', PROXY_PORT);
  mcServer = mc.createServer({
    host: '0.0.0.0',
    port: PROXY_PORT,
    'online-mode': true,
    version: MC_VERSION
  });

  // raw connection event on underlying net.Server to apply token-bucket
  mcServer.on('connection', (socket) => {
    const ip = socket.remoteAddress;
    if (isBanned(ip)) {
      console.log('Rejecting connection from banned IP', ip);
      // close quickly
      try { socket.destroy(); } catch(_) {}
      return;
    }
    if (!consumeToken(ip)) {
      console.log('Rate limit exceeded for', ip, '— closing socket');
      try { socket.destroy(); } catch(_) {}
      return;
    }
    // allow connection — tokens consumed above
  });

  mcServer.on('login', (client) => {
    const ip = client.socket.remoteAddress;
    const uuid = (client.uuid || '').replace(/-/g,'').toLowerCase(); // normalized
    const username = client.username || '';

    console.log(`login: ${username} ${uuid} from ${ip}`);

    // Check whitelist
    if (!isWhitelisted(uuid)) {
      console.log('Rejecting non-whitelisted UUID', uuid, 'from', ip);
      // record a failure for this IP
      recordFail(ip);
      client.end(JSON.stringify({ text: 'You are not authorized to start this server.' }));
      return;
    }

    // Whitelisted — start instance if needed, but do not let this login pass to backend here
    console.log('Authorized UUID, starting instance (if not already)', uuid);
    startInstance();

    // friendly disconnect telling the user to reconnect shortly
    client.end(JSON.stringify({ text: `Server is starting for authorized player ${username}. Please reconnect in ~45s.` }));
  });

  mcServer.on('error', (err) => {
    console.error('mcServer error', err);
  });
}

function stopMinecraftFriendlyServer() {
  if (!mcServer) return;
  try {
    mcServer.close(() => { console.log('mcServer closed'); mcServer = null; });
    setTimeout(()=>{ if (mcServer) { try { mcServer.close(); mcServer = null; } catch(_){} } }, 2000);
  } catch (err) { console.error('Error closing mcServer', err); mcServer = null; }
}

/* ---------- TCP forward mode ---------- */
function switchToTcpForwardMode(targetIp) {
  stopMinecraftFriendlyServer();
  if (tcpServer) return;
  console.log('Switching to TCP-forward mode to', targetIp, TARGET_PORT);

  tcpServer = net.createServer((clientSock) => {
    const ip = clientSock.remoteAddress;
    console.log('forward: client connected', ip, clientSock.remotePort);
    cancelShutdownTimer();
    const backendSock = net.createConnection({ host: targetIp, port: TARGET_PORT }, () => {
      clientSock.pipe(backendSock);
      backendSock.pipe(clientSock);
      activeSockets.add(clientSock);
    });

    const cleanup = () => {
      activeSockets.delete(clientSock);
      try { clientSock.destroy(); } catch(_) {}
      try { backendSock.destroy(); } catch(_) {}
      if (activeSockets.size === 0) scheduleShutdownTimer();
    };

    backendSock.on('error', (e) => { console.error('backendSock error', e); try { clientSock.destroy(); } catch(_){}; });
    clientSock.on('error', () => {});
    backendSock.on('close', cleanup);
    clientSock.on('close', cleanup);
  });

  tcpServer.on('error', (e) => { console.error('tcpServer error', e); });
  tcpServer.listen(PROXY_PORT, () => {
    console.log('TCP forward listening on', PROXY_PORT);
  });
}

function stopTcpForwardServer() {
  if (!tcpServer) return;
  try {
    tcpServer.close(() => { console.log('tcpServer closed'); tcpServer = null; });
    setTimeout(()=>{ if (tcpServer) { try { tcpServer.close(); tcpServer = null; } catch(_){} } }, 2000);
  } catch (err) { console.error('Error closing tcpServer', err); tcpServer = null; }
}

function switchToFriendlyMode() {
  console.log('Switching to friendly-disconnect mode');
  stopTcpForwardServer();
  backendHost = null;
  backendReady = false;
  startMinecraftFriendlyServer();
}

/* ---------- Shutdown scheduling ---------- */
function scheduleShutdownTimer() {
  if (shutdownTimer) return;
  console.log(`No players — scheduling shutdown in ${SHUTDOWN_IDLE_MINUTES} minutes`);
  shutdownTimer = setTimeout(async () => {
    shutdownTimer = null;
    if (activeSockets.size === 0) {
      await stopInstance();
    } else {
      console.log('Players returned during the delay; aborting shutdown.');
    }
  }, SHUTDOWN_IDLE_MINUTES * 60_000);
}
function cancelShutdownTimer() {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; console.log('Cancelled shutdown timer'); }
}

/* ---------- Admin HTTP API ---------- */
const app = express();
app.use(bodyParser.json());

function requireAdmin(req, res, next) {
  const token = req.header('x-admin-token') || req.query.token;
  if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/whitelist', requireAdmin, (req, res) => {
  res.json({ whitelist: Array.from(whitelistSet) });
});

// Add either { uuid: "..." } or { username: "..." } in body
app.post('/whitelist', requireAdmin, async (req, res) => {
  try {
    let { uuid, username } = req.body || {};
    if (username && !uuid) {
      // convert username -> uuid using Mojang API
      const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`);
      if (!r.ok) return res.status(400).json({ error: 'username not found' });
      const data = await r.json();
      uuid = (data.id || '').toLowerCase();
      if (!uuid) return res.status(400).json({ error: 'could not resolve username' });
    }
    if (!uuid) return res.status(400).json({ error: 'uuid or username required' });
    addWhitelist(uuid);
    await saveWhitelist();
    res.json({ ok: true, uuid });
  } catch (err) {
    console.error('admin add whitelist error', err);
    res.status(500).json({ error: 'internal' });
  }
});

app.delete('/whitelist/:uuid', requireAdmin, async (req, res) => {
  const u = req.params.uuid;
  if (!u) return res.status(400).json({ error: 'uuid required' });
  const ok = removeWhitelist(u);
  await saveWhitelist();
  res.json({ ok, uuid: u });
});

// Manual control
app.post('/start', requireAdmin, async (req, res) => { startInstance(); res.json({ started: true }); });
app.post('/stop', requireAdmin, async (req, res) => { stopInstance(); res.json({ stopped: true }); });
app.get('/status', requireAdmin, async (req, res) => {
  const inst = await describeInstance();
  res.json({ backendReady, backendHost, instance: inst?.State?.Name || 'unknown' });
});

const ADMIN_PORT = 3000;
app.listen(ADMIN_PORT, () => console.log(`Admin API listening on http://0.0.0.0:${ADMIN_PORT} — provide x-admin-token header`));

/* ---------- Init ---------- */
(async function main(){
  await loadWhitelist();
  switchToFriendlyMode();

  // poll EC2 occasionally to detect manual start/stop
  setInterval(async () => {
    try {
      const inst = await describeInstance();
      const state = inst?.State?.Name;
      const ip = inst?.PublicIpAddress || null;
      if (state === 'running' && ip && !backendReady) {
        console.log('Detected running instance externally; switching to forward mode', ip);
        backendHost = ip;
        backendReady = true;
        switchToTcpForwardMode(ip);
      } else if (state !== 'running' && backendReady) {
        console.log('Instance no longer running — reverting to friendly mode');
        backendHost = null;
        backendReady = false;
        switchToFriendlyMode();
      }
    } catch (err) {
      // ignore
    }
  }, 30_000);

  // graceful shutdown
  process.on('SIGINT', () => { console.log('SIGINT'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0); });
})();
