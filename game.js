/**
 * ============================================================================
 * 3D MOB CONTROL / CANNON CLASH P2P ENGINE (game.js)
 * ============================================================================
 * 
 * Features:
 * - Room-Based P2P Architecture (Native BroadcastChannel + WebRTC)
 * - Interactive 3D Drag & Drop Arena Level Designer:
 *   * Direct dragging of gates, barriers, pipes, portals, blocks, and bridges
 *   * Live repositioning on the track with touch & mouse
 *   * Item selection, deletion, and 1-click presets
 * - Dual 3D Rendering Modes:
 *   * DESIGNER MODE: Tactical top-down overview with lane grid & drag targets
 *   * CHASE MODE: 3D perspective chase view from each player's OWN tank POV
 * - All 14 Track Hazards, Barriers & Active Threats (Groups A, B, and C)
 * - Robust 4-System Netcode Layer:
 *   * Host-Authoritative Arbiter (Single Source of Truth, max 400ms pending resolution)
 *   * 4-Ping NTP Clock Synchronization
 *   * Timestamped Inputs & Deterministic 3D Trajectory Advancement (clamped 300ms)
 *   * Periodic Checksum State Healing (1.0 Hz)
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NetcodeGame = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const NetcodeConfig = {
    LANE_WIDTH: 22,
    LANE_LENGTH: 130,
    CANNON_MIN_X: -8.0,
    CANNON_MAX_X: 8.0,

    BASE_MAX_HP: 100,
    BASE_SHIELD_MAX_HP: 40,
    MOB_DAMAGE: 5,

    CANNON_SLIDE_SPEED: 24,
    MOB_SPEED: 22.0,
    GIANT_SPEED: 12.0,
    FIRE_COOLDOWN_MS: 190,

    NTP_HANDSHAKE_PINGS: 4,
    MAX_LATENCY_COMPENSATION_MS: 300,
    STATE_SYNC_INTERVAL_MS: 1000,
    PENDING_RESOLUTION_MAX_TIMEOUT_MS: 400
  };

  function getNow() {
    if (typeof performance !== 'undefined' && performance.now) {
      return performance.now();
    }
    return Date.now();
  }

  function seededPseudoRandom(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  // --------------------------------------------------------------------------
  // Default Map Templates & Hazard Definitions
  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // SYMMETRIC MAP GENERATOR (100% Fair POV Mirroring)
  // --------------------------------------------------------------------------

  function buildSymmetricArena(halfLayout) {
    const trackWidth = halfLayout.trackWidth || 20;
    const fullGates = [];
    const fullObstacles = [];

    // 1. Process Gates
    for (const gate of (halfLayout.gates || [])) {
      if (gate.isMirror) continue;
      // Creator gate on Host half (forced to Z > 0)
      const hostGate = {
        ...gate,
        x: gate.x || 0,
        z: Math.max(3, Math.abs(gate.z || 15)),
        isMirror: false
      };
      fullGates.push(hostGate);

      // Mirrored twin gate on Joiner half (Z < 0)
      const mirrorGate = {
        ...gate,
        id: `${gate.id}_mirror`,
        sourceId: gate.id,
        x: -hostGate.x,
        z: -hostGate.z,
        label: gate.label,
        color: gate.color,
        multiplier: gate.multiplier,
        addVal: gate.addVal,
        subVal: gate.subVal,
        divVal: gate.divVal,
        width: gate.width,
        moving: gate.moving,
        oscSpeed: gate.oscSpeed,
        oscRange: gate.oscRange,
        isMirror: true
      };
      fullGates.push(mirrorGate);
    }

    // 2. Process Obstacles
    for (const obs of (halfLayout.obstacles || [])) {
      if (obs.isMirror) continue;
      const hostObs = {
        ...obs,
        x: obs.x || 0,
        z: Math.max(3, Math.abs(obs.z || 15)),
        isMirror: false
      };
      fullObstacles.push(hostObs);

      const mirrorObs = {
        ...obs,
        id: `${obs.id}_mirror`,
        sourceId: obs.id,
        x: -hostObs.x,
        z: -hostObs.z,
        width: obs.width,
        depth: obs.depth,
        height: obs.height,
        radius: obs.radius,
        length: obs.length,
        hp: obs.hp,
        maxHp: obs.maxHp,
        color: obs.color,
        cycleDuration: obs.cycleDuration,
        pushZ: obs.pushZ ? -obs.pushZ : undefined, // Reverse conveyor push on opponent side
        isMirror: true
      };

      if (obs.type === "PORTAL" && obs.entrance && obs.exit) {
        mirrorObs.entrance = { x: -obs.entrance.x, z: -Math.abs(obs.entrance.z) };
        mirrorObs.exit = { x: -obs.exit.x, z: -Math.abs(obs.exit.z) };
      }

      fullObstacles.push(mirrorObs);
    }

    return {
      name: halfLayout.name || "Symmetric Duel Arena",
      trackWidth: trackWidth,
      gates: fullGates,
      obstacles: fullObstacles,
      features: halfLayout.features || { hasBaseShield: true, championSpawns: true }
    };
  }

  const DefaultCreatorHalfLayout = {
    name: "Canyon Gauntlet",
    trackWidth: 20,
    gates: [
      { id: "gate_mult_x2", type: "MULT", x: -4.5, width: 7, z: 24, multiplier: 2, label: "✖2", color: "#00d4ff", moving: false },
      { id: "gate_mult_x3", type: "MULT", x: 4.5, width: 7, z: 12, multiplier: 3, label: "✖3", color: "#00e5ff", moving: true, oscSpeed: 1.8, oscRange: 2.5 },
      { id: "gate_sub_10", type: "SUB", x: 3.5, width: 6, z: 34, subVal: 10, label: "➖10", color: "#ef4444", moving: false }
    ],
    obstacles: [
      { id: "obs_wall", type: "BARRIER", x: -5.5, z: 16, width: 2.5, depth: 10, height: 2.2, color: "#7c4d32" },
      { id: "conveyor_back", type: "CONVEYOR", x: 0, z: 20, width: 6, depth: 8, pushZ: 8.0 },
      { id: "block_50", type: "HEALTH_BLOCK", x: 0, z: 30, width: 3.5, depth: 3.5, height: 2.0, hp: 50, maxHp: 50, color: "#f59e0b" },
      { id: "portal_pair", type: "PORTAL", entrance: { x: -4.5, z: 40 }, exit: { x: -4.5, z: 8 } }
    ],
    features: {
      hasBaseShield: true,
      championSpawns: true,
      hasBossEncounter: false
    }
  };

  const DefaultArenaLayout = buildSymmetricArena(DefaultCreatorHalfLayout);

  // --------------------------------------------------------------------------
  // Hybrid P2P Networking Transport
  // --------------------------------------------------------------------------

  class BaseTransport {
    constructor() { this.onMessage = null; }
    send(packet) {}
    close() {}
  }

  class HybridP2PTransport extends BaseTransport {
    constructor(roomCode, isHost) {
      super();
      this.roomCode = (roomCode || "ARENA_101").toUpperCase().trim();
      this.isHost = isHost;
      this.latencyMs = 0;
      this.jitterMs = 0;
      this.isConnected = false;

      this.peer = null;
      this.conn = null;
      this.bChannel = null;

      this.initBroadcastChannel();
      this.initWebRTC();
    }

    initBroadcastChannel() {
      if (typeof BroadcastChannel !== 'undefined') {
        const chanName = `mob_clash_${this.roomCode}`;
        this.bChannel = new BroadcastChannel(chanName);
        this.bChannel.onmessage = (event) => {
          const raw = event.data;
          if (raw && raw._senderRole !== (this.isHost ? "HOST" : "GUEST")) {
            this.dispatchMessage(raw.payload);
          }
        };
      }
    }

    initWebRTC() {
      if (typeof Peer === 'undefined') return;
      const peerId = this.isHost ? `mobclash_host_${this.roomCode}` : `mobclash_guest_${this.roomCode}_${Math.floor(Math.random() * 10000)}`;

      try {
        this.peer = new Peer(peerId, { debug: 0 });

        this.peer.on('open', () => {
          if (!this.isHost) {
            const targetHostId = `mobclash_host_${this.roomCode}`;
            const conn = this.peer.connect(targetHostId, { reliable: true });
            this.setupDataConnection(conn);
          }
        });

        this.peer.on('connection', (conn) => {
          if (this.isHost) {
            this.setupDataConnection(conn);
          }
        });

        this.peer.on('error', () => {});
      } catch (e) {}
    }

    setupDataConnection(conn) {
      this.conn = conn;
      conn.on('open', () => {
        this.isConnected = true;
        if (this.onConnected) this.onConnected();
      });
      conn.on('data', (data) => {
        this.dispatchMessage(data);
      });
      conn.on('close', () => {
        this.isConnected = false;
      });
    }

    dispatchMessage(payload) {
      const delay = Math.max(0, this.latencyMs + (Math.random() * 2 - 1) * this.jitterMs);
      if (delay <= 0) {
        if (this.onMessage) this.onMessage(payload);
      } else {
        setTimeout(() => {
          if (this.onMessage) this.onMessage(payload);
        }, delay);
      }
    }

    send(packet) {
      if (this.conn && this.conn.open) {
        try { this.conn.send(packet); } catch (e) {}
      }
      if (this.bChannel) {
        try {
          this.bChannel.postMessage({
            _senderRole: this.isHost ? "HOST" : "GUEST",
            payload: JSON.parse(JSON.stringify(packet))
          });
        } catch (e) {}
      }
    }

    setSimulatedLatency(latencyMs, jitterMs = 0) {
      this.latencyMs = latencyMs;
      this.jitterMs = jitterMs;
    }

    close() {
      if (this.bChannel) this.bChannel.close();
      if (this.conn) this.conn.close();
      if (this.peer) this.peer.destroy();
    }
  }

  // --------------------------------------------------------------------------
  // SYSTEM 2: Clock Synchronization (NTP Handshake)
  // --------------------------------------------------------------------------

  class ClockSynchronizer {
    constructor(isHost, transport) {
      this.isHost = isHost;
      this.transport = transport;

      this.clockOffset = 0;
      this.rtt = 0;
      this.isSynchronized = isHost;
      this.pingSamples = [];
      this.currentPingId = 0;
      this.handshakeCompleteCallback = null;
      this.maxPings = NetcodeConfig.NTP_HANDSHAKE_PINGS;
      this.lastHeartbeatTime = 0;
    }

    startHandshake(onComplete = null) {
      this.handshakeCompleteCallback = onComplete;
      this.pingSamples = [];
      this.currentPingId = 0;
      this.isSynchronized = false;
      if (this.isHost) return;
      this.sendPing(0);
    }

    sendPing(pingId) {
      this.currentPingId = pingId;
      const t0 = getNow();
      this.transport.send({ type: "PING", pingId: pingId, t0: t0 });
    }

    handlePing(packet) {
      if (!this.isHost) return;
      const t1 = getNow();
      this.transport.send({ type: "PONG", pingId: packet.pingId, t0: packet.t0, t1: t1 });
    }

    handlePong(packet) {
      if (this.isHost) return;
      const t2 = getNow();
      const t0 = packet.t0;
      const t1 = packet.t1;

      const sampleRtt = t2 - t0;
      const sampleOffset = t1 - (t0 + sampleRtt / 2);
      this.pingSamples.push({ rtt: sampleRtt, offset: sampleOffset });

      if (this.pingSamples.length < this.maxPings) {
        setTimeout(() => this.sendPing(this.pingSamples.length), 20);
      } else {
        const totalRtt = this.pingSamples.reduce((sum, s) => sum + s.rtt, 0);
        const totalOffset = this.pingSamples.reduce((sum, s) => sum + s.offset, 0);
        this.rtt = totalRtt / this.pingSamples.length;
        this.clockOffset = totalOffset / this.pingSamples.length;
        this.isSynchronized = true;

        this.transport.send({ type: "SYNC_COMPLETE", rtt: this.rtt, clockOffset: this.clockOffset });
        if (this.handshakeCompleteCallback) {
          this.handshakeCompleteCallback({ rtt: this.rtt, clockOffset: this.clockOffset, samples: this.pingSamples });
        }
      }
    }

    handleSyncComplete(packet) {
      if (this.isHost) {
        this.rtt = packet.rtt;
        this.isSynchronized = true;
        if (this.handshakeCompleteCallback) {
          this.handshakeCompleteCallback({ rtt: this.rtt, clockOffset: 0 });
        }
      }
    }

    updateHeartbeat(currentTime) {
      if (!this.isSynchronized) return;
      if (currentTime - this.lastHeartbeatTime >= 1500) {
        this.lastHeartbeatTime = currentTime;
        if (!this.isHost) {
          this.transport.send({ type: "LIVE_PING", t0: getNow() });
        }
      }
    }

    handleLivePing(packet) {
      if (this.isHost) this.transport.send({ type: "LIVE_PONG", t0: packet.t0 });
    }

    handleLivePong(packet) {
      if (!this.isHost) {
        const measuredRtt = getNow() - packet.t0;
        this.rtt = this.rtt * 0.7 + measuredRtt * 0.3;
        this.transport.send({ type: "NOTIFY_RTT", rtt: this.rtt });
      }
    }

    handleNotifyRtt(packet) {
      if (this.isHost) this.rtt = packet.rtt;
    }

    getSyncedTime() {
      const localTime = getNow();
      return this.isHost ? localTime : (localTime + this.clockOffset);
    }
  }

  // --------------------------------------------------------------------------
  // SYSTEM 1: Host-Authoritative Win/Loss Arbiter
  // --------------------------------------------------------------------------

  class WinLossArbiter {
    constructor(isHost, transport, onGameOverCallback, onStateChangeCallback) {
      this.isHost = isHost;
      this.transport = transport;
      this.onGameOverCallback = onGameOverCallback;
      this.onStateChangeCallback = onStateChangeCallback;

      this.state = "IDLE";
      this.winner = null;
      this.matchResultTimestamp = 0;

      this.pendingStartTime = 0;
      this.pendingTimeoutTimer = null;
      this.pendingResolutionMaxMs = NetcodeConfig.PENDING_RESOLUTION_MAX_TIMEOUT_MS;
    }

    setState(newState) {
      if (this.state === newState) return;
      const oldState = this.state;
      this.state = newState;
      if (this.onStateChangeCallback) this.onStateChangeCallback(newState, oldState);
    }

    checkBaseDestruction(hostHp, guestHp) {
      if (this.state !== "PLAYING" && this.state !== "PENDING_RESOLUTION") return;

      const hostBaseDead = hostHp <= 0;
      const guestBaseDead = guestHp <= 0;

      if (!hostBaseDead && !guestBaseDead) return;

      if (this.isHost) {
        let determinedWinner = "GUEST";
        if (guestBaseDead && !hostBaseDead) determinedWinner = "HOST";
        else if (hostBaseDead && !guestBaseDead) determinedWinner = "GUEST";
        else if (hostBaseDead && guestBaseDead) determinedWinner = hostHp >= guestHp ? "HOST" : "GUEST";

        this.declareAuthoritativeResult(determinedWinner);
      } else {
        if (this.state !== "PENDING_RESOLUTION") {
          this.enterPendingResolution();
        }
      }
    }

    declareAuthoritativeResult(winner) {
      if (this.state === "GAME_OVER") return;
      this.winner = winner;
      this.matchResultTimestamp = getNow();
      this.setState("GAME_OVER");

      this.transport.send({
        type: "MATCH_RESULT",
        winner: this.winner,
        timestamp: this.matchResultTimestamp
      });

      if (this.onGameOverCallback) this.onGameOverCallback(this.winner, "HOST_AUTHORITATIVE");
    }

    enterPendingResolution() {
      this.setState("PENDING_RESOLUTION");
      this.pendingStartTime = getNow();

      if (this.pendingTimeoutTimer) clearTimeout(this.pendingTimeoutTimer);
      this.pendingTimeoutTimer = setTimeout(() => {
        if (this.state === "PENDING_RESOLUTION") {
          console.warn("[Arbiter] 400ms Pending Resolution timeout reached without Host confirmation.");
        }
      }, this.pendingResolutionMaxMs);
    }

    handleMatchResult(packet) {
      if (this.state === "GAME_OVER") return;
      if (this.pendingTimeoutTimer) {
        clearTimeout(this.pendingTimeoutTimer);
        this.pendingTimeoutTimer = null;
      }
      this.winner = packet.winner;
      this.matchResultTimestamp = packet.timestamp;
      this.setState("GAME_OVER");

      if (this.onGameOverCallback) this.onGameOverCallback(this.winner, "YIELDED_TO_HOST");
    }
  }

  // --------------------------------------------------------------------------
  // SYSTEM 3: Timestamped Inputs & Deterministic Entity Spawning
  // --------------------------------------------------------------------------

  class InputEntitySpawner {
    constructor(game) {
      this.game = game;
      this.nextMobId = 1;
    }

    createInputPacket(x, angle, firing, isChampion = false) {
      return {
        type: "INPUT",
        x: x,
        angle: angle,
        firing: firing,
        isChampion: isChampion,
        sendTime: this.game.clockSync.getSyncedTime()
      };
    }

    handleOpponentInput(packet) {
      const currentSyncedTime = this.game.clockSync.getSyncedTime();
      const rawLatency = currentSyncedTime - packet.sendTime;
      const clampedLatency = Math.min(Math.max(rawLatency, 0), NetcodeConfig.MAX_LATENCY_COMPENSATION_MS);

      const opponentCannon = this.game.isHost ? this.game.guestCannon : this.game.hostCannon;
      opponentCannon.x = packet.x;
      opponentCannon.angle = packet.angle;

      if (packet.firing) {
        this.spawnEnemyMobWithLatencyCompensation(packet, clampedLatency, packet.isChampion);
        if (this.game.renderer3D) {
          this.game.renderer3D.triggerMuzzleFlash(!this.game.isHost);
        }
      }
    }

    spawnEnemyMobWithLatencyCompensation(packet, latencyMs, isChampion = false) {
      const owner = this.game.isHost ? "GUEST" : "HOST";
      const mobSpeed = isChampion ? NetcodeConfig.GIANT_SPEED : NetcodeConfig.MOB_SPEED;

      const originZ = owner === "GUEST" ? -48.0 : 48.0;
      const dirZ = owner === "GUEST" ? 1.0 : -1.0;

      const advanceDistance = mobSpeed * (latencyMs / 1000.0);
      const spawnZ = originZ + dirZ * advanceDistance;

      const mob = {
        id: `${owner}_${this.nextMobId++}_${Math.floor(packet.sendTime)}`,
        owner: owner,
        isChampion: isChampion,
        hp: isChampion ? 12 : 1,
        maxHp: isChampion ? 12 : 1,
        x: packet.x,
        y: isChampion ? 1.4 : 0.5,
        z: spawnZ,
        vx: 0,
        vz: dirZ * mobSpeed,
        radius: isChampion ? 1.4 : 0.6,
        color: owner === "HOST" ? "#2563eb" : "#ef4444",
        passedGates: new Set()
      };

      this.game.mobs.push(mob);
      return mob;
    }

    spawnLocalMob(x, originZ, angle, isChampion = false) {
      const owner = this.game.isHost ? "HOST" : "GUEST";
      const mobSpeed = isChampion ? NetcodeConfig.GIANT_SPEED : NetcodeConfig.MOB_SPEED;
      const dirZ = owner === "HOST" ? -1.0 : 1.0;

      const mob = {
        id: `${owner}_${this.nextMobId++}_${Math.floor(this.game.clockSync.getSyncedTime())}`,
        owner: owner,
        isChampion: isChampion,
        hp: isChampion ? 12 : 1,
        maxHp: isChampion ? 12 : 1,
        x: x,
        y: isChampion ? 1.4 : 0.5,
        z: originZ,
        vx: 0,
        vz: dirZ * mobSpeed,
        radius: isChampion ? 1.4 : 0.6,
        color: owner === "HOST" ? "#2563eb" : "#ef4444",
        passedGates: new Set()
      };

      this.game.mobs.push(mob);
      return mob;
    }
  }

  // --------------------------------------------------------------------------
  // SYSTEM 4: Periodic Checksum State Healing
  // --------------------------------------------------------------------------

  class StateChecksumHealer {
    constructor(game) {
      this.game = game;
      this.lastSyncSentTime = 0;
      this.syncInterval = NetcodeConfig.STATE_SYNC_INTERVAL_MS;
      this.lastHealedDiscrepancy = null;
      this.healingActive = false;
    }

    update(currentTime) {
      if (!this.game.isHost) return;
      if (this.game.arbiter.state !== "PLAYING") return;

      if (currentTime - this.lastSyncSentTime >= this.syncInterval) {
        this.lastSyncSentTime = currentTime;
        this.broadcastStateSync();
      }
    }

    broadcastStateSync() {
      const hostMobs = this.game.mobs.filter(m => m.owner === "HOST").length;
      const guestMobs = this.game.mobs.filter(m => m.owner === "GUEST").length;
      const matchClock = this.game.clockSync.getSyncedTime() - this.game.matchStartTime;

      this.game.transport.send({
        type: "STATE_SYNC",
        hostHp: this.game.hostBase.hp,
        guestHp: this.game.guestBase.hp,
        hostShieldHp: this.game.hostBase.shieldHp,
        guestShieldHp: this.game.guestBase.shieldHp,
        hostActiveMobs: hostMobs,
        guestActiveMobs: guestMobs,
        matchClock: Math.max(0, matchClock)
      });
    }

    handleStateSync(packet) {
      if (this.game.isHost) return;

      const currentHostHp = this.game.hostBase.hp;
      const currentGuestHp = this.game.guestBase.hp;
      const hasDiscrepancy = Math.abs(currentHostHp - packet.hostHp) > 0.05 || Math.abs(currentGuestHp - packet.guestHp) > 0.05;

      if (hasDiscrepancy) {
        this.lastHealedDiscrepancy = {
          time: getNow(),
          prevHostHp: currentHostHp,
          authoritativeHostHp: packet.hostHp
        };
        this.healingActive = true;
      }

      this.game.hostBase.targetHp = packet.hostHp;
      this.game.guestBase.targetHp = packet.guestHp;
      this.game.hostBase.shieldHp = packet.hostShieldHp;
      this.game.guestBase.shieldHp = packet.guestShieldHp;
    }

    applySmoothHealing(dt) {
      if (this.game.isHost) return;
      const lerpFactor = Math.min(1.0, dt * 10.0);

      if (this.game.hostBase.targetHp !== undefined) {
        const diff = this.game.hostBase.targetHp - this.game.hostBase.hp;
        if (Math.abs(diff) < 0.2) this.game.hostBase.hp = this.game.hostBase.targetHp;
        else this.game.hostBase.hp += diff * lerpFactor;
      }

      if (this.game.guestBase.targetHp !== undefined) {
        const diff = this.game.guestBase.targetHp - this.game.guestBase.hp;
        if (Math.abs(diff) < 0.2) this.game.guestBase.hp = this.game.guestBase.targetHp;
        else this.game.guestBase.hp += diff * lerpFactor;
      }
    }
  }

  // --------------------------------------------------------------------------
  // DUAL 3D RENDERER (DESIGNER OVERVIEW & CHASE POV)
  // --------------------------------------------------------------------------

  class CanvasRenderer3D {
    constructor(container, isHost, arenaLayout, viewMode = "CHASE") {
      this.container = container;
      this.isHost = isHost;
      this.arenaLayout = arenaLayout;
      this.viewMode = viewMode; // "DESIGNER" or "CHASE"

      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');
      container.appendChild(this.canvas);

      this.recoil = 0;
      this.selectedObstacleId = null;
      this.dragPreview = null; // { type, x, z, label, color }

      this.resize();

      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => this.resize());
        ro.observe(container);
      }
    }

    resize() {
      const w = this.container.clientWidth || 480;
      const h = this.container.clientHeight || 700;
      this.canvas.width = w;
      this.canvas.height = h;
    }

    rebuildWorld(newLayout) {
      this.arenaLayout = newLayout;
    }

    triggerMuzzleFlash(isHost) {
      this.recoil = 10;
    }

    // ------------------------------------------------------------------------
    // Coordinate Mapping (Responsive to Custom Route Width)
    // ------------------------------------------------------------------------

    // Designer Mode: Top-Down Tactical Blueprint Mapping
    trackToDesignerScreen(x, z) {
      const w = this.canvas.width;
      const h = this.canvas.height;
      const marginY = 40;
      const marginX = 32;

      const usableH = h - marginY * 2;
      const usableW = w - marginX * 2;

      const trackW = this.arenaLayout?.trackWidth || 20;
      const halfW_padded = (trackW / 2) + 1.2;

      // Z runs from -56 (top enemy base) to +52 (bottom player base)
      const normZ = (z - (-56)) / (52 - (-56));
      const sy = marginY + normZ * usableH;

      // X runs from -halfW_padded to +halfW_padded
      const normX = (x - (-halfW_padded)) / (halfW_padded * 2);
      const sx = marginX + normX * usableW;

      return { x: sx, y: sy };
    }

    designerScreenToTrack(sx, sy) {
      const w = this.canvas.width;
      const h = this.canvas.height;
      const marginY = 40;
      const marginX = 32;

      const usableH = h - marginY * 2;
      const usableW = w - marginX * 2;

      const trackW = this.arenaLayout?.trackWidth || 20;
      const halfW = trackW / 2;
      const halfW_padded = halfW + 1.2;

      const normZ = Math.max(0, Math.min(1, (sy - marginY) / usableH));
      const z = -56 + normZ * (52 - (-56));

      const normX = Math.max(0, Math.min(1, (sx - marginX) / usableW));
      const x = -halfW_padded + normX * (halfW_padded * 2);

      // Clamped strictly to Room Creator's Half (Z in [3, 44]) and current Track Width
      const clampedX = Math.max(-halfW + 1.5, Math.min(halfW - 1.5, x));
      const clampedZ = Math.max(3, Math.min(44, z));

      return { x: clampedX, z: clampedZ };
    }

    // Chase Mode: Forward 3D Perspective Camera Projection
    projectChase(x, y, z) {
      const w = this.canvas.width;
      const h = this.canvas.height;
      const horizon = h * 0.38;
      const focal = h * 0.75;
      const camY = 11.5;

      let relX = x;
      let relY = y;
      let relZ = 0;

      if (this.isHost) {
        relZ = 64.0 - z; // Host camera at Z = 64 looking down -Z (enemy base at Z = -56)
      } else {
        relX = -x;
        relZ = z - (-64.0); // Guest camera at Z = -64 looking down +Z (host base at Z = 56)
      }

      if (relZ <= 1.5) return null; // Behind camera

      const scale = focal / relZ;
      const screenX = w / 2.0 + relX * scale;
      const screenY = horizon + (camY - relY) * scale;

      return { x: screenX, y: screenY, scale: scale, depth: relZ };
    }

    // ------------------------------------------------------------------------
    // Render Orchestrator
    // ------------------------------------------------------------------------

    render(game, dt) {
      if (this.viewMode === "DESIGNER") {
        this.renderDesignerOverview(game, dt);
      } else {
        this.renderChaseMode(game, dt);
      }
    }

    // ------------------------------------------------------------------------
    // 1. DESIGNER OVERVIEW: Tactical Top-Down Interactive Builder
    // ------------------------------------------------------------------------

    renderDesignerOverview(game, dt) {
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      if (!ctx || w === 0 || h === 0) return;

      const trackW = this.arenaLayout?.trackWidth || 20;
      const halfW = trackW / 2;

      // Dark tactical blueprint arena background
      ctx.fillStyle = '#070c18';
      ctx.fillRect(0, 0, w, h);

      // Track Quad Boundaries (Responsive to custom route width)
      const pTopL = this.trackToDesignerScreen(-halfW, -56);
      const pTopR = this.trackToDesignerScreen(halfW, -56);
      const pBotL = this.trackToDesignerScreen(-halfW, 52);
      const pBotR = this.trackToDesignerScreen(halfW, 52);

      // Canyon Ground
      ctx.fillStyle = '#111827';
      ctx.beginPath();
      ctx.moveTo(pTopL.x, pTopL.y);
      ctx.lineTo(pTopR.x, pTopR.y);
      ctx.lineTo(pBotR.x, pBotR.y);
      ctx.lineTo(pBotL.x, pBotL.y);
      ctx.closePath();
      ctx.fill();

      // Opponent's Half Shading (Z < 0 is auto-mirrored)
      const pMidL = this.trackToDesignerScreen(-halfW, 0);
      const pMidR = this.trackToDesignerScreen(halfW, 0);

      ctx.fillStyle = 'rgba(6, 182, 212, 0.08)';
      ctx.beginPath();
      ctx.moveTo(pTopL.x, pTopL.y);
      ctx.lineTo(pTopR.x, pTopR.y);
      ctx.lineTo(pMidR.x, pMidR.y);
      ctx.lineTo(pMidL.x, pMidL.y);
      ctx.closePath();
      ctx.fill();

      // Glowing Cyan Border
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Dynamic Lane Guidelines across route width
      const numLanes = Math.max(3, Math.round(trackW / 5));
      const laneStep = trackW / numLanes;
      for (let i = 1; i < numLanes; i++) {
        const lx = -halfW + i * laneStep;
        const p1 = this.trackToDesignerScreen(lx, -54);
        const p2 = this.trackToDesignerScreen(lx, 50);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // MIDFIELD SYMMETRY LINE (Z = 0)
      ctx.save();
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(pMidL.x, pMidL.y);
      ctx.lineTo(pMidR.x, pMidR.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#06b6d4';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText("⚽ MIDFIELD SYMMETRY LINE (100% FAIR MIRROR) ⚽", w / 2, pMidL.y - 6);
      ctx.restore();

      // Opponent Half Auto-Mirror Indicator
      ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText("OPPONENT HALF (AUTO-MIRRORED FOR IDENTICAL POV)", w / 2, (pTopL.y + pMidL.y) / 2);

      // Creator Half Design Zone Indicator
      ctx.fillStyle = 'rgba(56, 189, 248, 0.8)';
      ctx.fillText("YOUR HALF (ROOM CREATOR DESIGN AREA)", w / 2, (pMidL.y + pBotL.y) / 2);

      // Enemy Base at Top
      const pEnemy = this.trackToDesignerScreen(0, -55);
      const baseW = Math.min(160, (halfW * 1.6) * ((w - 64) / (trackW + 2.4)));
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(pEnemy.x - baseW / 2, pEnemy.y - 12, baseW, 22);
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(pEnemy.x - baseW / 2, pEnemy.y - 12, baseW, 22);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText("🏰 ENEMY FORTRESS", pEnemy.x, pEnemy.y + 4);

      // Player Base at Bottom
      const pPlayer = this.trackToDesignerScreen(0, 50);
      ctx.fillStyle = '#1d4ed8';
      ctx.fillRect(pPlayer.x - baseW / 2, pPlayer.y - 10, baseW, 22);
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(pPlayer.x - baseW / 2, pPlayer.y - 10, baseW, 22);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText("🎯 YOUR CANNON BASE", pPlayer.x, pPlayer.y + 6);

      // Render Obstacles in Designer View
      for (const obs of this.arenaLayout.obstacles) {
        const isSelected = this.selectedObstacleId === obs.id || (obs.sourceId && this.selectedObstacleId === obs.sourceId);
        const isMirror = obs.isMirror;
        ctx.save();

        if (obs.type === "BARRIER") {
          const pt = this.trackToDesignerScreen(obs.x, obs.z);
          ctx.fillStyle = isSelected ? '#fbbf24' : (obs.color || '#7c4d32');
          ctx.globalAlpha = isMirror ? 0.75 : 1.0;
          ctx.fillRect(pt.x - 14, pt.y - 26, 28, 52);
          ctx.strokeStyle = isSelected ? '#ffffff' : (isMirror ? '#06b6d4' : '#451a03');
          ctx.lineWidth = isSelected ? 3 : (isMirror ? 2 : 1.5);
          if (isMirror) ctx.setLineDash([3, 3]);
          ctx.strokeRect(pt.x - 14, pt.y - 26, 28, 52);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1.0;

          ctx.fillStyle = '#fff';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(isMirror ? "WALL 🪞" : "🧱 WALL", pt.x, pt.y + 3);
        } else if (obs.type === "PIPE") {
          const pt = this.trackToDesignerScreen(obs.x, obs.z);
          ctx.fillStyle = isSelected ? '#a3e635' : '#22c55e';
          ctx.globalAlpha = isMirror ? 0.75 : 1.0;
          ctx.fillRect(pt.x - 15, pt.y - 30, 30, 60);
          ctx.strokeStyle = isSelected ? '#ffffff' : (isMirror ? '#06b6d4' : '#15803d');
          ctx.lineWidth = isSelected ? 3 : 2;
          if (isMirror) ctx.setLineDash([3, 3]);
          ctx.strokeRect(pt.x - 15, pt.y - 30, 30, 60);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1.0;

          ctx.fillStyle = '#fff';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(isMirror ? "PIPE 🪞" : "🟢 PIPE", pt.x, pt.y + 3);
        } else if (obs.type === "VOID_GAP") {
          const pt = this.trackToDesignerScreen(obs.x || 0, obs.z || 0);
          ctx.fillStyle = '#050811';
          ctx.fillRect(pt.x - 26, pt.y - 18, 52, 36);
          ctx.strokeStyle = isSelected ? '#ffffff' : (isMirror ? '#06b6d4' : '#ef4444');
          ctx.lineWidth = isSelected ? 3 : 1.5;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(pt.x - 26, pt.y - 18, 52, 36);
          ctx.setLineDash([]);
          ctx.fillStyle = '#f87171';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(isMirror ? "VOID 🪞" : "🕳️ VOID", pt.x, pt.y + 3);
        } else if (obs.type === "MOVING_BRIDGE") {
          const pt = this.trackToDesignerScreen(obs.x || 0, obs.z || 0);
          ctx.fillStyle = isSelected ? '#fbbf24' : '#b45309';
          ctx.globalAlpha = isMirror ? 0.75 : 1.0;
          ctx.fillRect(pt.x - 28, pt.y - 18, 56, 36);
          ctx.strokeStyle = isSelected ? '#ffffff' : (isMirror ? '#06b6d4' : '#f59e0b');
          ctx.lineWidth = isSelected ? 3 : 2;
          if (isMirror) ctx.setLineDash([3, 3]);
          ctx.strokeRect(pt.x - 28, pt.y - 18, 56, 36);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1.0;

          ctx.fillStyle = '#fff';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(isMirror ? "BRIDGE 🪞" : "🌉 BRIDGE", pt.x, pt.y + 3);
        } else if (obs.type === "CONVEYOR") {
          const pt = this.trackToDesignerScreen(obs.x || 0, obs.z || 0);
          ctx.fillStyle = '#334155';
          ctx.fillRect(pt.x - 24, pt.y - 20, 48, 40);
          ctx.strokeStyle = isSelected ? '#38bdf8' : (isMirror ? '#06b6d4' : '#64748b');
          ctx.lineWidth = isSelected ? 3 : 1.5;
          if (isMirror) ctx.setLineDash([3, 3]);
          ctx.strokeRect(pt.x - 24, pt.y - 20, 48, 40);
          ctx.setLineDash([]);
          ctx.fillStyle = '#94a3b8';
          ctx.font = 'bold 10px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(isMirror ? "BELT ▲ 🪞" : "BELT ▼", pt.x, pt.y + 4);
        } else if (obs.type === "PORTAL") {
          const p1 = this.trackToDesignerScreen(obs.entrance.x, obs.entrance.z);
          const p2 = this.trackToDesignerScreen(obs.exit.x, obs.exit.z);
          ctx.fillStyle = isMirror ? '#7c3aed' : '#8b5cf6';
          ctx.beginPath();
          ctx.arc(p1.x, p1.y, 13, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = isMirror ? '#9333ea' : '#a855f7';
          ctx.beginPath();
          ctx.arc(p2.x, p2.y, 13, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = isMirror ? '#06b6d4' : '#c084fc';
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 8px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText("IN 🌀", p1.x, p1.y + 3);
          ctx.fillText("OUT 🌀", p2.x, p2.y + 3);
        } else if (obs.type === "HEALTH_BLOCK") {
          const pt = this.trackToDesignerScreen(obs.x || 0, obs.z || 0);
          ctx.fillStyle = isSelected ? '#fde047' : '#f59e0b';
          ctx.globalAlpha = isMirror ? 0.75 : 1.0;
          ctx.fillRect(pt.x - 18, pt.y - 18, 36, 36);
          ctx.strokeStyle = isSelected ? '#ffffff' : (isMirror ? '#06b6d4' : '#d97706');
          ctx.lineWidth = isSelected ? 3 : 2;
          if (isMirror) ctx.setLineDash([3, 3]);
          ctx.strokeRect(pt.x - 18, pt.y - 18, 36, 36);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1.0;

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`${obs.hp} HP`, pt.x, pt.y + 4);
        }
        ctx.restore();
      }

      // Render Gates in Designer View
      for (const gate of this.arenaLayout.gates) {
        const isSelected = this.selectedObstacleId === gate.id || (gate.sourceId && this.selectedObstacleId === gate.sourceId);
        const isMirror = gate.isMirror;
        const pt = this.trackToDesignerScreen(gate.x || 0, gate.z);
        const gw = (gate.width || 7) * ((w - 64) / (trackW + 2.4));

        ctx.save();
        ctx.fillStyle = isSelected ? '#facc15' : gate.color;
        ctx.globalAlpha = isMirror ? 0.65 : 0.88;
        ctx.fillRect(pt.x - gw / 2, pt.y - 12, gw, 24);
        ctx.globalAlpha = 1.0;

        ctx.strokeStyle = isSelected ? '#ffffff' : (isMirror ? '#06b6d4' : '#000000');
        ctx.lineWidth = isSelected ? 3 : (isMirror ? 2 : 1.5);
        if (isMirror) ctx.setLineDash([3, 3]);
        ctx.strokeRect(pt.x - gw / 2, pt.y - 12, gw, 24);
        ctx.setLineDash([]);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        const labelText = isMirror ? `${gate.label} 🪞` : gate.label;
        ctx.fillText(labelText, pt.x, pt.y + 4);

        if (gate.moving) {
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(pt.x - 18, pt.y);
          ctx.lineTo(pt.x + 18, pt.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        ctx.restore();
      }

      // Drag Preview Crosshair (when dragging from palette)
      if (this.dragPreview) {
        const pt = this.trackToDesignerScreen(this.dragPreview.x, this.dragPreview.z);
        const mirrorPt = this.trackToDesignerScreen(-this.dragPreview.x, -this.dragPreview.z);

        ctx.save();
        // Creator drop target
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(pt.x - 24, pt.y - 16, 48, 32);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.3)';
        ctx.fillRect(pt.x - 24, pt.y - 16, 48, 32);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`Drop: ${this.dragPreview.label}`, pt.x, pt.y + 4);

        // Mirrored twin preview
        ctx.strokeStyle = '#06b6d4';
        ctx.strokeRect(mirrorPt.x - 24, mirrorPt.y - 16, 48, 32);
        ctx.fillStyle = 'rgba(6, 182, 212, 0.2)';
        ctx.fillRect(mirrorPt.x - 24, mirrorPt.y - 16, 48, 32);
        ctx.fillStyle = '#67e8f9';
        ctx.fillText(`Mirrored 🪞`, mirrorPt.x, mirrorPt.y + 4);

        ctx.restore();
      }

      // Top Designer Guide Bar
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.fillRect(10, 8, w - 20, 22);
      ctx.fillStyle = '#38bdf8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`ROUTE WIDTH: ${trackW}m • Design bottom half; opponent half is 100% symmetrically auto-mirrored!`, w / 2, 22);
    }

    // ------------------------------------------------------------------------
    // 2. CHASE MODE: 3D Perspective Chase View from Player's Own Tank POV
    // ------------------------------------------------------------------------

    renderChaseMode(game, dt) {
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      if (!ctx || w === 0 || h === 0) return;

      const trackW = this.arenaLayout?.trackWidth || 20;
      const halfW = trackW / 2;

      this.recoil *= Math.max(0, 1.0 - dt * 15.0);

      // Warm Sunset Canyon Sky
      const skyGrad = ctx.createLinearGradient(0, 0, 0, h * 0.38);
      skyGrad.addColorStop(0, '#fef3c7');
      skyGrad.addColorStop(0.55, '#fde68a');
      skyGrad.addColorStop(1, '#fb923c');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, w, h);

      // Distant Canyon Mesas along Horizon
      ctx.fillStyle = '#9a3412';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.38);
      ctx.lineTo(w * 0.2, h * 0.26);
      ctx.lineTo(w * 0.45, h * 0.35);
      ctx.lineTo(w * 0.72, h * 0.24);
      ctx.lineTo(w, h * 0.38);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();

      // Canyon Ground Base
      ctx.fillStyle = '#b45309';
      ctx.fillRect(0, h * 0.38, w, h * 0.62);

      // 3D Sandy Highway Road Quad (Scales with Custom Route Width)
      const pNearL = this.projectChase(-halfW, 0, this.isHost ? 50 : -50);
      const pNearR = this.projectChase(halfW, 0, this.isHost ? 50 : -50);
      const pFarL = this.projectChase(-halfW, 0, this.isHost ? -58 : 58);
      const pFarR = this.projectChase(halfW, 0, this.isHost ? -58 : 58);

      if (pNearL && pNearR && pFarL && pFarR) {
        // Highway asphalt / sand surface
        const roadGrad = ctx.createLinearGradient(0, pFarL.y, 0, pNearL.y);
        roadGrad.addColorStop(0, '#d97706');
        roadGrad.addColorStop(0.6, '#f59e0b');
        roadGrad.addColorStop(1, '#fbbf24');

        ctx.fillStyle = roadGrad;
        ctx.beginPath();
        ctx.moveTo(pNearL.x, pNearL.y);
        ctx.lineTo(pFarL.x, pFarL.y);
        ctx.lineTo(pFarR.x, pFarR.y);
        ctx.lineTo(pNearR.x, pNearR.y);
        ctx.closePath();
        ctx.fill();

        // High-contrast edge curbs
        ctx.strokeStyle = '#92400e';
        ctx.lineWidth = 3.5;
        ctx.stroke();

        // Dynamic Dashed Lane Guidelines across the widened track
        const numLanes = Math.max(3, Math.round(trackW / 5));
        const laneStep = trackW / numLanes;
        for (let i = 1; i < numLanes; i++) {
          const lx = -halfW + i * laneStep;
          const pLaneNear = this.projectChase(lx, 0.05, this.isHost ? 48 : -48);
          const pLaneFar = this.projectChase(lx, 0.05, this.isHost ? -56 : 56);
          if (pLaneNear && pLaneFar) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 12]);
            ctx.beginPath();
            ctx.moveTo(pLaneNear.x, pLaneNear.y);
            ctx.lineTo(pLaneFar.x, pLaneFar.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      // Render Floor Decals (Under entities)
      for (const obs of this.arenaLayout.obstacles) {
        if (obs.type === "VOID_GAP") {
          const gw = (obs.width || 7) / 2;
          const pVL = this.projectChase((obs.x || 0) - gw, 0, obs.z - 4);
          const pVR = this.projectChase((obs.x || 0) + gw, 0, obs.z - 4);
          const pVN_L = this.projectChase((obs.x || 0) - gw, 0, obs.z + 4);
          const pVN_R = this.projectChase((obs.x || 0) + gw, 0, obs.z + 4);
          if (pVL && pVR && pVN_L && pVN_R) {
            ctx.fillStyle = '#050811';
            ctx.beginPath();
            ctx.moveTo(pVN_L.x, pVN_L.y);
            ctx.lineTo(pVL.x, pVL.y);
            ctx.lineTo(pVR.x, pVR.y);
            ctx.lineTo(pVN_R.x, pVN_R.y);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        } else if (obs.type === "CONVEYOR") {
          const cw = (obs.width || 6) / 2;
          const pCL = this.projectChase((obs.x || 0) - cw, 0.05, obs.z - 4);
          const pCR = this.projectChase((obs.x || 0) + cw, 0.05, obs.z - 4);
          const pCN_L = this.projectChase((obs.x || 0) - cw, 0.05, obs.z + 4);
          const pCN_R = this.projectChase((obs.x || 0) + cw, 0.05, obs.z + 4);
          if (pCL && pCR && pCN_L && pCN_R) {
            ctx.fillStyle = '#1e293b';
            ctx.beginPath();
            ctx.moveTo(pCN_L.x, pCN_L.y);
            ctx.lineTo(pCL.x, pCL.y);
            ctx.lineTo(pCR.x, pCR.y);
            ctx.lineTo(pCN_R.x, pCN_R.y);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        } else if (obs.type === "PORTAL") {
          const pEnt = this.projectChase(obs.entrance.x, 0.05, obs.entrance.z);
          const pExt = this.projectChase(obs.exit.x, 0.05, obs.exit.z);
          if (pEnt) {
            ctx.fillStyle = '#8b5cf6';
            ctx.beginPath();
            ctx.ellipse(pEnt.x, pEnt.y, 18 * pEnt.scale * 0.1, 7 * pEnt.scale * 0.1, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#c084fc';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          if (pExt) {
            ctx.fillStyle = '#a855f7';
            ctx.beginPath();
            ctx.ellipse(pExt.x, pExt.y, 18 * pExt.scale * 0.1, 7 * pExt.scale * 0.1, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#e9d5ff';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
      }

      // Render Opponent Base Fortress at Horizon (Scales with Track Width)
      const oppZ = this.isHost ? -56 : 56;
      const pOppBase = this.projectChase(0, 0, oppZ);
      if (pOppBase) {
        const bw = Math.min(260, Math.max(80, (trackW * 0.88) * pOppBase.scale));
        const bh = bw * 0.52;
        const oppColor = this.isHost ? '#dc2626' : '#2563eb';

        // Castle Base
        ctx.fillStyle = oppColor;
        ctx.fillRect(pOppBase.x - bw / 2, pOppBase.y - bh, bw, bh);

        // Battlements
        ctx.fillStyle = '#1e293b';
        const numBattles = 5;
        const bStep = bw / numBattles;
        for (let b = 0; b < numBattles; b += 2) {
          ctx.fillRect(pOppBase.x - bw / 2 + b * bStep, pOppBase.y - bh - 8, bStep, 8);
        }

        // Arched Gate
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(pOppBase.x - bw * 0.18, pOppBase.y - bh * 0.55, bw * 0.36, bh * 0.55);

        // Base Shield Energy Bubble (Hazard 9)
        const oppShield = this.isHost ? game.guestBase.shieldHp : game.hostBase.shieldHp;
        if (oppShield > 0) {
          ctx.save();
          ctx.fillStyle = 'rgba(6, 182, 212, 0.35)';
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(pOppBase.x, pOppBase.y - bh * 0.6, bw * 0.65, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }

        // Base Health Floating Badge
        const oppHp = this.isHost ? game.guestBase.hp : game.hostBase.hp;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(pOppBase.x - bw / 2, pOppBase.y - bh - 24, bw, 18);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(pOppBase.x - bw / 2, pOppBase.y - bh - 24, bw, 18);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        const shieldLabel = oppShield > 0 ? `🛡️${Math.round(oppShield)} ` : "";
        ctx.fillText(`${shieldLabel}${Math.round(oppHp)} HP`, pOppBase.x, pOppBase.y - bh - 11);
      }

      // Render 3D Obstacles (Barriers, Pipes, Health Blocks)
      for (const obs of this.arenaLayout.obstacles) {
        if (obs.type === "BARRIER") {
          const pt = this.projectChase(obs.x, 0, obs.z);
          if (pt) {
            const bw = Math.max(16, (obs.width || 2.5) * pt.scale);
            const bh = Math.max(22, (obs.height || 2.2) * pt.scale);
            ctx.fillStyle = obs.color || '#7c4d32';
            ctx.fillRect(pt.x - bw / 2, pt.y - bh, bw, bh);
            ctx.strokeStyle = '#451a03';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(pt.x - bw / 2, pt.y - bh, bw, bh);

            ctx.fillStyle = '#fff';
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText("WALL", pt.x, pt.y - bh / 2 + 3);
          }
        } else if (obs.type === "PIPE") {
          const pt = this.projectChase(obs.x, 0, obs.z);
          if (pt) {
            const pw = Math.max(20, (obs.radius || 2) * 2 * pt.scale);
            const ph = Math.max(26, 3.5 * pt.scale);
            ctx.fillStyle = '#22c55e';
            ctx.fillRect(pt.x - pw / 2, pt.y - ph, pw, ph);
            ctx.strokeStyle = '#15803d';
            ctx.lineWidth = 2;
            ctx.strokeRect(pt.x - pw / 2, pt.y - ph, pw, ph);
          }
        } else if (obs.type === "HEALTH_BLOCK") {
          const pt = this.projectChase(obs.x || 0, 0, obs.z || 0);
          if (pt) {
            const bw = Math.max(24, 3.5 * pt.scale);
            ctx.fillStyle = '#f59e0b';
            ctx.fillRect(pt.x - bw / 2, pt.y - bw, bw, bw);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.strokeRect(pt.x - bw / 2, pt.y - bw, bw, bw);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`${obs.hp} HP`, pt.x, pt.y - bw / 2 + 4);
          }
        }
      }

      // Render 3D Multiplier / Subtraction Gates
      for (const gate of this.arenaLayout.gates) {
        const offset = gate.currentOffset || 0;
        const gateX = (gate.x || 0) + offset;
        const gwUnits = gate.width || 7;

        const pGateL = this.projectChase(gateX - gwUnits / 2, 0, gate.z);
        const pGateR = this.projectChase(gateX + gwUnits / 2, 0, gate.z);
        const pGateTop = this.projectChase(gateX, 3.6, gate.z);

        if (pGateL && pGateR && pGateTop) {
          const gw = Math.max(34, pGateR.x - pGateL.x);
          const gh = Math.max(24, pGateL.y - pGateTop.y);
          const topY = pGateTop.y;

          ctx.save();
          // Support Posts
          ctx.fillStyle = '#334155';
          ctx.fillRect(pGateL.x - 4, topY - 4, 8, gh + 4);
          ctx.fillRect(pGateR.x - 4, topY - 4, 8, gh + 4);

          // Glowing Holographic Banner
          ctx.fillStyle = gate.color || '#00d4ff';
          ctx.globalAlpha = 0.65;
          ctx.fillRect(pGateL.x, topY, gw, gh);
          ctx.globalAlpha = 1.0;

          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.strokeRect(pGateL.x, topY, gw, gh);

          // Bold Clamped Multiplier / Math Label
          const fontSize = Math.min(20, Math.max(11, Math.round(13 * pGateTop.scale)));
          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(gate.label, (pGateL.x + pGateR.x) / 2, topY + gh / 2);
          ctx.restore();
        }
      }

      // Render 3D Mobs (Painter's algorithm: farthest first, nearest last)
      const sortedMobs = [...game.mobs].sort((a, b) => {
        const relZA = this.isHost ? (64.0 - a.z) : (a.z - (-64.0));
        const relZB = this.isHost ? (64.0 - b.z) : (b.z - (-64.0));
        return relZB - relZA;
      });

      for (const mob of sortedMobs) {
        const pMob = this.projectChase(mob.x, mob.y, mob.z);
        if (pMob) {
          const mult = mob.isChampion ? 2.2 : 1.0;
          const r = Math.max(3.5, mob.radius * pMob.scale * 1.4 * mult);

          // Giant Champion Golden Aura
          if (mob.isChampion) {
            ctx.fillStyle = 'rgba(245, 158, 11, 0.4)';
            ctx.beginPath();
            ctx.arc(pMob.x, pMob.y - r * 1.5, r * 1.8, 0, Math.PI * 2);
            ctx.fill();
          }

          // Stickman Body
          ctx.fillStyle = mob.color;
          ctx.beginPath();
          ctx.arc(pMob.x, pMob.y - r * 1.1, r, 0, Math.PI * 2);
          ctx.fill();

          // Stickman Head
          ctx.fillStyle = '#ffdbac';
          ctx.beginPath();
          ctx.arc(pMob.x, pMob.y - r * 2.2, r * 0.65, 0, Math.PI * 2);
          ctx.fill();

          // Champion Crown
          if (mob.isChampion) {
            ctx.fillStyle = '#facc15';
            ctx.fillRect(pMob.x - r * 0.5, pMob.y - r * 3.0, r, r * 0.4);
          }
        }
      }

      // Render Player's Own Cannon at Bottom Center
      const myCannon = this.isHost ? game.hostCannon : game.guestCannon;
      const myZ = this.isHost ? 48 : -48;
      const pMy = this.projectChase(myCannon.x, 0, myZ);

      if (pMy) {
        const cw = Math.min(84, Math.max(48, 42 * pMy.scale));
        const ch = cw * 0.52;
        const myColor = this.isHost ? '#2563eb' : '#dc2626';

        // Dual Recoil Barrels (Pointing forward/up)
        ctx.fillStyle = '#1e293b';
        const recoilOffset = this.recoil;
        ctx.fillRect(pMy.x - 10, pMy.y - ch - 20 + recoilOffset, 7, 24);
        ctx.fillRect(pMy.x + 3, pMy.y - ch - 20 + recoilOffset, 7, 24);

        // Cannon Chassis Body
        ctx.fillStyle = myColor;
        ctx.beginPath();
        ctx.roundRect(pMy.x - cw / 2, pMy.y - ch, cw, ch, 8);
        ctx.fill();

        // Wheels
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(pMy.x - cw / 2 - 6, pMy.y - ch + 4, 6, ch - 8);
        ctx.fillRect(pMy.x + cw / 2, pMy.y - ch + 4, 6, ch - 8);
      }

      // Sparks & Particles
      for (const p of game.particles) {
        const pPt = this.projectChase(p.x, p.y, p.z);
        if (pPt) {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(pPt.x, pPt.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }


  class PeerGame {
    constructor(options = {}) {
      this.isHost = options.isHost !== undefined ? options.isHost : true;
      this.roomCode = options.roomCode || "ARENA_101";
      this.container = options.container || null;
      this.viewMode = options.viewMode || "CHASE"; // "DESIGNER" or "CHASE"
      this.arenaLayout = options.arenaLayout || JSON.parse(JSON.stringify(DefaultArenaLayout));
      this.transport = options.transport || new HybridP2PTransport(this.roomCode, this.isHost);

      this.hostBase = {
        z: 56,
        hp: NetcodeConfig.BASE_MAX_HP,
        maxHp: NetcodeConfig.BASE_MAX_HP,
        targetHp: NetcodeConfig.BASE_MAX_HP,
        shieldHp: this.arenaLayout.features?.hasBaseShield ? NetcodeConfig.BASE_SHIELD_MAX_HP : 0
      };

      this.guestBase = {
        z: -56,
        hp: NetcodeConfig.BASE_MAX_HP,
        maxHp: NetcodeConfig.BASE_MAX_HP,
        targetHp: NetcodeConfig.BASE_MAX_HP,
        shieldHp: this.arenaLayout.features?.hasBaseShield ? NetcodeConfig.BASE_SHIELD_MAX_HP : 0
      };

      this.hostCannon = { x: 0, z: 48, angle: 0, isFiring: false, lastFireTime: 0 };
      this.guestCannon = { x: 0, z: -48, angle: 0, isFiring: false, lastFireTime: 0 };

      this.championEnergy = 0;
      this.maxChampionEnergy = 100;

      this.mobs = [];
      this.particles = [];
      this.activeBlocks = JSON.parse(JSON.stringify(this.arenaLayout.obstacles.filter(o => o.type === "HEALTH_BLOCK")));

      this.matchStartTime = 0;
      this.countdownNumber = 3;
      this.countdownTimer = null;
      this.worldTime = 0;

      this.clockSync = new ClockSynchronizer(this.isHost, this.transport);
      this.arbiter = new WinLossArbiter(
        this.isHost,
        this.transport,
        (winner, reason) => this.onGameOver(winner, reason),
        (newState) => this.onArbiterStateChange(newState)
      );
      this.spawner = new InputEntitySpawner(this);
      this.checksumHealer = new StateChecksumHealer(this);

      this.onHudUpdate = options.onHudUpdate || null;
      this.onGameOverCallback = options.onGameOver || null;

      this.localKeys = {};
      this.targetSliderX = 0;
      this.isMouseDown = false;

      this.transport.onMessage = (packet) => this.handlePacket(packet);

      this.lastFrameTime = getNow();
      this.animationFrameId = null;
      this.isRunning = false;

      this.renderer3D = null;
      if (this.container) {
        this.renderer3D = new CanvasRenderer3D(this.container, this.isHost, this.arenaLayout, this.viewMode);
      }
    }

    setArenaLayout(newLayout) {
      this.arenaLayout = newLayout;
      this.activeBlocks = JSON.parse(JSON.stringify(this.arenaLayout.obstacles.filter(o => o.type === "HEALTH_BLOCK")));
      if (this.renderer3D) {
        this.renderer3D.rebuildWorld(this.arenaLayout);
      }
    }

    handlePacket(packet) {
      if (!packet || !packet.type) return;

      switch (packet.type) {
        case "MAP_SYNC":
          if (!this.isHost && packet.arenaLayout) this.setArenaLayout(packet.arenaLayout);
          break;
        case "PING":
          if (this.isHost) {
            this.transport.send({ type: "MAP_SYNC", arenaLayout: this.arenaLayout });
          }
          this.clockSync.handlePing(packet);
          break;
        case "PONG":
          this.clockSync.handlePong(packet);
          break;
        case "SYNC_COMPLETE":
          this.clockSync.handleSyncComplete(packet);
          break;
        case "LIVE_PING":
          this.clockSync.handleLivePing(packet);
          break;
        case "LIVE_PONG":
          this.clockSync.handleLivePong(packet);
          break;
        case "NOTIFY_RTT":
          this.clockSync.handleNotifyRtt(packet);
          break;
        case "INPUT":
          this.spawner.handleOpponentInput(packet);
          break;
        case "STATE_SYNC":
          this.checksumHealer.handleStateSync(packet);
          break;
        case "MATCH_RESULT":
          this.arbiter.handleMatchResult(packet);
          break;
        case "START_COUNTDOWN":
          this.beginCountdown(packet.countdownFrom || 3);
          break;
        case "START_MATCH":
          this.beginMatch(packet.startTime);
          break;
      }
    }

    initiateClockSync(onComplete) {
      if (this.isHost) {
        this.transport.send({ type: "MAP_SYNC", arenaLayout: this.arenaLayout });
      }

      this.clockSync.startHandshake((result) => {
        if (this.isHost) {
          setTimeout(() => this.broadcastStartCountdown(3), 300);
        }
        if (onComplete) onComplete(result);
      });
    }

    broadcastStartCountdown(seconds = 3) {
      if (!this.isHost) return;
      this.transport.send({ type: "START_COUNTDOWN", countdownFrom: seconds });
      this.beginCountdown(seconds);
    }

    beginCountdown(seconds = 3) {
      this.arbiter.setState("COUNTDOWN");
      this.countdownNumber = seconds;

      const tick = () => {
        if (this.countdownNumber > 1) {
          this.countdownNumber--;
          this.countdownTimer = setTimeout(tick, 800);
        } else {
          this.countdownNumber = 0;
          if (this.isHost) {
            const startTimestamp = this.clockSync.getSyncedTime();
            this.transport.send({ type: "START_MATCH", startTime: startTimestamp });
            this.beginMatch(startTimestamp);
          }
        }
      };
      this.countdownTimer = setTimeout(tick, 800);
    }

    beginMatch(startTime) {
      this.matchStartTime = startTime || this.clockSync.getSyncedTime();
      this.arbiter.setState("PLAYING");
    }

    onArbiterStateChange(newState) {
      if (this.onHudUpdate) this.onHudUpdate(this.getDebugStats());
    }

    onGameOver(winner, reason) {
      if (this.onGameOverCallback) this.onGameOverCallback(winner, reason);
    }

    update(dt) {
      const now = getNow();
      this.worldTime += dt;

      if (this.arbiter.state === "PLAYING") {
        this.processLocalInput(now, dt);
      }

      this.updateMovingObstacles(dt);
      this.updateMobs(dt);
      this.updateParticles(dt);

      this.checksumHealer.applySmoothHealing(dt);
      this.checksumHealer.update(now);
      this.clockSync.updateHeartbeat(now);

      if (this.arbiter.state === "PLAYING" || this.arbiter.state === "PENDING_RESOLUTION") {
        this.arbiter.checkBaseDestruction(this.hostBase.hp, this.guestBase.hp);
      }

      if (this.onHudUpdate) this.onHudUpdate(this.getDebugStats());
    }

    updateMovingObstacles(dt) {
      for (const gate of this.arenaLayout.gates) {
        if (gate.moving) {
          const speed = gate.oscSpeed || 2.0;
          const range = gate.oscRange || 3.0;
          const dir = gate.isMirror ? -1 : 1; // Symmetrical horizontal oscillation
          gate.currentOffset = dir * Math.sin(this.worldTime * speed) * range;
        }
      }
    }

    processLocalInput(now, dt) {
      const myCannon = this.isHost ? this.hostCannon : this.guestCannon;
      const diffX = this.targetSliderX - myCannon.x;
      myCannon.x += diffX * Math.min(1.0, dt * 14.0);

      let moveDir = 0;
      if (this.localKeys['ArrowLeft'] || this.localKeys['KeyA']) moveDir -= 1;
      if (this.localKeys['ArrowRight'] || this.localKeys['KeyD']) moveDir += 1;
      if (moveDir !== 0) {
        myCannon.x += moveDir * NetcodeConfig.CANNON_SLIDE_SPEED * dt;
        this.targetSliderX = myCannon.x;
      }

      const trackW = this.arenaLayout?.trackWidth || 20;
      const maxClamp = Math.max(4.0, trackW / 2 - 2.5);
      myCannon.x = Math.max(-maxClamp, Math.min(maxClamp, myCannon.x));

      if (this.championEnergy < this.maxChampionEnergy) {
        this.championEnergy = Math.min(this.maxChampionEnergy, this.championEnergy + dt * 12.0);
      }

      const fireRequested = this.localKeys['Space'] || this.isMouseDown;
      let actuallyFired = false;

      if (fireRequested && (now - myCannon.lastFireTime >= NetcodeConfig.FIRE_COOLDOWN_MS)) {
        myCannon.lastFireTime = now;
        actuallyFired = true;

        const originZ = this.isHost ? 48.0 : -48.0;
        this.spawner.spawnLocalMob(myCannon.x, originZ, myCannon.angle, false);

        if (this.renderer3D) {
          this.renderer3D.triggerMuzzleFlash(this.isHost);
        }
      }

      const inputPacket = this.spawner.createInputPacket(myCannon.x, myCannon.angle, actuallyFired, false);
      this.transport.send(inputPacket);
    }

    spawnChampion() {
      if (this.championEnergy < 100) return;
      this.championEnergy = 0;

      const myCannon = this.isHost ? this.hostCannon : this.guestCannon;
      const originZ = this.isHost ? 48.0 : -48.0;
      this.spawner.spawnLocalMob(myCannon.x, originZ, myCannon.angle, true);

      const inputPacket = this.spawner.createInputPacket(myCannon.x, myCannon.angle, true, true);
      this.transport.send(inputPacket);
    }

    updateMobs(dt) {
      const newClonedMobs = [];

      for (let i = this.mobs.length - 1; i >= 0; i--) {
        const mob = this.mobs[i];

        for (const obs of this.arenaLayout.obstacles) {
          if (obs.type === "CONVEYOR") {
            if (Math.abs(mob.x - (obs.x || 0)) < (obs.width || 6) / 2 && Math.abs(mob.z - (obs.z || 0)) < (obs.depth || 8) / 2) {
              mob.z += (mob.vz < 0 ? -1 : 1) * (obs.pushZ || 0) * dt;
            }
          }
        }

        mob.z += mob.vz * dt;

        for (const obs of this.arenaLayout.obstacles) {
          if (obs.type === "VOID_GAP") {
            if (Math.abs(mob.x - (obs.x || 0)) < (obs.width || 7) / 2 && Math.abs(mob.z - (obs.z || 0)) < (obs.depth || 8) / 2) {
              mob.isFalling = true;
            }
          }
        }

        if (mob.isFalling) {
          mob.y -= 18.0 * dt;
          if (mob.y < -8.0) {
            this.mobs.splice(i, 1);
            continue;
          }
        }

        for (const obs of this.arenaLayout.obstacles) {
          if (obs.type === "BARRIER") {
            if (Math.abs(mob.z - obs.z) < obs.depth / 2 + 0.4 && Math.abs(mob.x - obs.x) < obs.width / 2 + 0.4) {
              mob.x += (mob.x > obs.x ? 1 : -1) * 9.0 * dt;
            }
          }
        }

        for (let bIdx = this.activeBlocks.length - 1; bIdx >= 0; bIdx--) {
          const blk = this.activeBlocks[bIdx];
          if (blk.hp > 0) {
            if (Math.abs(mob.x - (blk.x || 0)) < blk.width / 2 + 0.5 && Math.abs(mob.z - (blk.z || 0)) < blk.depth / 2 + 0.5) {
              blk.hp -= 1;
              this.createImpactSparks(mob.x, 1.0, mob.z, "#f59e0b", 4);
              this.mobs.splice(i, 1);
              if (blk.hp <= 0) {
                this.createImpactSparks(blk.x, 1.5, blk.z, "#ffffff", 20);
                this.activeBlocks.splice(bIdx, 1);
              }
              break;
            }
          }
        }
        if (!this.mobs.includes(mob)) continue;

        if (mob.x < -9.5) mob.x = -9.5;
        if (mob.x > 9.5) mob.x = 9.5;

        // Gates
        for (const gate of this.arenaLayout.gates) {
          if (!mob.passedGates.has(gate.id)) {
            const gateOffset = gate.currentOffset || 0;
            const gateX = (gate.x || 0) + gateOffset;
            const halfW = (gate.width || 7) / 2;

            const crossedZ = (mob.vz < 0 && mob.z <= gate.z && mob.z >= gate.z - 3.2) ||
                             (mob.vz > 0 && mob.z >= gate.z && mob.z <= gate.z + 3.2);
            const inX = mob.x >= gateX - halfW && mob.x <= gateX + halfW;

            if (crossedZ && inX) {
              mob.passedGates.add(gate.id);

              if (gate.type === "MULT") {
                const extras = gate.multiplier - 1;
                for (let k = 0; k < extras; k++) {
                  const seed = (mob.id.length * 37 + k * 19 + Math.floor(mob.z)) % 1000;
                  const spreadX = (seededPseudoRandom(seed) - 0.5) * 1.6;
                  newClonedMobs.push({
                    ...mob,
                    id: `${mob.id}_x${gate.multiplier}_${k}`,
                    x: Math.max(-9.0, Math.min(9.0, mob.x + spreadX)),
                    z: mob.z + (seededPseudoRandom(seed + 1) - 0.5) * 1.2,
                    passedGates: new Set(mob.passedGates)
                  });
                }
                this.createImpactSparks(mob.x, 1.0, mob.z, gate.color, 6);
              } else if (gate.type === "ADD") {
                const addCount = gate.addVal || 5;
                for (let k = 0; k < addCount; k++) {
                  const seed = (mob.id.length * 31 + k * 17) % 1000;
                  newClonedMobs.push({
                    ...mob,
                    id: `${mob.id}_add_${k}`,
                    x: Math.max(-9.0, Math.min(9.0, mob.x + (seededPseudoRandom(seed) - 0.5) * 1.8)),
                    z: mob.z + (seededPseudoRandom(seed + 2) - 0.5) * 1.4,
                    passedGates: new Set(mob.passedGates)
                  });
                }
                this.createImpactSparks(mob.x, 1.0, mob.z, gate.color, 8);
              } else if (gate.type === "SUB") {
                this.createImpactSparks(mob.x, 1.0, mob.z, "#ef4444", 12);
                this.mobs.splice(i, 1);
                break;
              } else if (gate.type === "DIV") {
                if (Math.random() < 0.5) {
                  this.createImpactSparks(mob.x, 1.0, mob.z, "#dc2626", 6);
                  this.mobs.splice(i, 1);
                  break;
                }
              }
            }
          }
        }
        if (!this.mobs.includes(mob)) continue;

        // Combat Clash
        if (mob.owner === "HOST") {
          for (let j = this.mobs.length - 1; j >= 0; j--) {
            const other = this.mobs[j];
            if (other.owner === "GUEST") {
              const dx = mob.x - other.x;
              const dz = mob.z - other.z;
              if (dx * dx + dz * dz < 1.4 * 1.4) {
                mob.hp -= other.isChampion ? 4 : 1;
                other.hp -= mob.isChampion ? 4 : 1;
                this.createImpactSparks((mob.x + other.x) / 2, 1.0, (mob.z + other.z) / 2, "#ffffff", 8);

                if (other.hp <= 0) this.mobs.splice(j, 1);
                if (mob.hp <= 0) {
                  this.mobs.splice(i, 1);
                  break;
                }
              }
            }
          }
          if (!this.mobs.includes(mob)) continue;
        }

        // Base Damage
        if (mob.owner === "HOST" && mob.z <= -50) {
          if (this.guestBase.shieldHp > 0) {
            this.guestBase.shieldHp = Math.max(0, this.guestBase.shieldHp - (mob.isChampion ? 15 : NetcodeConfig.MOB_DAMAGE));
            this.createImpactSparks(mob.x, 2.5, -52, "#38bdf8", 12);
          } else {
            this.guestBase.hp = Math.max(0, this.guestBase.hp - (mob.isChampion ? 15 : NetcodeConfig.MOB_DAMAGE));
            this.createImpactSparks(mob.x, 1.5, -52, "#ef4444", 12);
          }
          this.mobs.splice(i, 1);
          continue;
        }

        if (mob.owner === "GUEST" && mob.z >= 50) {
          if (this.hostBase.shieldHp > 0) {
            this.hostBase.shieldHp = Math.max(0, this.hostBase.shieldHp - (mob.isChampion ? 15 : NetcodeConfig.MOB_DAMAGE));
            this.createImpactSparks(mob.x, 2.5, 52, "#38bdf8", 12);
          } else {
            this.hostBase.hp = Math.max(0, this.hostBase.hp - (mob.isChampion ? 15 : NetcodeConfig.MOB_DAMAGE));
            this.createImpactSparks(mob.x, 1.5, 52, "#2563eb", 12);
          }
          this.mobs.splice(i, 1);
          continue;
        }

        if (mob.z < -68 || mob.z > 68) this.mobs.splice(i, 1);
      }

      for (const clone of newClonedMobs) this.mobs.push(clone);
    }

    createImpactSparks(x, y, z, colorHex, count = 8) {
      for (let i = 0; i < count; i++) {
        this.particles.push({
          x: x, y: y, z: z,
          vx: (Math.random() - 0.5) * 14.0,
          vy: Math.random() * 12.0 + 3.0,
          vz: (Math.random() - 0.5) * 14.0,
          color: colorHex,
          life: 0.35
        });
      }
    }

    updateParticles(dt) {
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.vy -= 25.0 * dt;
        p.life -= dt;
        if (p.life <= 0) this.particles.splice(i, 1);
      }
    }

    getDebugStats() {
      return {
        role: this.isHost ? "HOST" : "GUEST",
        roomCode: this.roomCode,
        state: this.arbiter.state,
        winner: this.arbiter.winner,
        rtt: Math.round(this.clockSync.rtt),
        clockOffset: this.clockSync.clockOffset,
        isSynchronized: this.clockSync.isSynchronized,
        syncedTime: this.clockSync.getSyncedTime(),
        hostHp: Math.round(this.hostBase.hp),
        guestHp: Math.round(this.guestBase.hp),
        hostShield: Math.round(this.hostBase.shieldHp),
        guestShield: Math.round(this.guestBase.shieldHp),
        championEnergy: Math.round(this.championEnergy),
        activeMobs: this.mobs.length,
        healingActive: this.checksumHealer.healingActive
      };
    }

    start() {
      if (this.isRunning) return;
      this.isRunning = true;
      this.lastFrameTime = getNow();

      const loop = (currentTime) => {
        if (!this.isRunning) return;
        const dt = Math.min(0.1, (currentTime - this.lastFrameTime) / 1000.0);
        this.lastFrameTime = currentTime;

        this.update(dt);
        if (this.renderer3D) this.renderer3D.render(this, dt);

        this.animationFrameId = requestAnimationFrame(loop);
      };

      this.animationFrameId = requestAnimationFrame(loop);
    }

    stop() {
      this.isRunning = false;
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      if (this.countdownTimer) clearTimeout(this.countdownTimer);
      if (this.transport) this.transport.close();
    }

    bindDOMEvents(sliderElement) {
      if (sliderElement) {
        sliderElement.addEventListener('input', (e) => {
          this.targetSliderX = parseFloat(e.target.value);
        });
      }

      window.addEventListener('keydown', (e) => {
        this.localKeys[e.code] = true;
        if (e.code === 'KeyE') this.spawnChampion();
      });

      window.addEventListener('keyup', (e) => {
        this.localKeys[e.code] = false;
      });

      if (this.container) {
        let isDragging = false;
        const onPointerDown = (clientX) => {
          isDragging = true;
          this.isMouseDown = true;
          this.updateTargetFromPointer(clientX);
        };
        const onPointerMove = (clientX) => {
          if (isDragging) this.updateTargetFromPointer(clientX);
        };
        const onPointerUp = () => {
          isDragging = false;
          this.isMouseDown = false;
        };

        this.container.addEventListener('mousedown', (e) => onPointerDown(e.clientX));
        window.addEventListener('mousemove', (e) => onPointerMove(e.clientX));
        window.addEventListener('mouseup', onPointerUp);

        this.container.addEventListener('touchstart', (e) => {
          if (e.touches && e.touches[0]) onPointerDown(e.touches[0].clientX);
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
          if (e.touches && e.touches[0]) onPointerMove(e.touches[0].clientX);
        }, { passive: true });

        window.addEventListener('touchend', onPointerUp);
      }
    }

    updateTargetFromPointer(clientX) {
      if (!this.container) return;
      const trackW = this.arenaLayout?.trackWidth || 20;
      const maxClamp = Math.max(4.0, trackW / 2 - 2.5);
      const rect = this.container.getBoundingClientRect();
      const normX = (clientX - rect.left) / rect.width;
      const rawX = (normX - 0.5) * (trackW - 2.0);
      const mappedX = this.isHost ? rawX : -rawX;
      this.targetSliderX = Math.max(-maxClamp, Math.min(maxClamp, mappedX));
    }
  }

  return {
    NetcodeConfig,
    DefaultArenaLayout,
    buildSymmetricArena,
    HybridP2PTransport,
    ClockSynchronizer,
    WinLossArbiter,
    InputEntitySpawner,
    StateChecksumHealer,
    CanvasRenderer3D,
    PeerGame,
    getNow
  };
}));
