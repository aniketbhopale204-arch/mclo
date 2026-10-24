# 🚀 CANNON CLASH 3D - P2P Mob Control Duel (`game.js`)

A real-time 3D multiplayer action duel game (styled like *Mob Control* and *Count Masters*) featuring:
- **100% Fair Half-Map POV Mirroring:** The room creator designs only their half of the track ($Z > 0$). Every placed obstacle, multiplier gate, and hazard is automatically point-reflected to the joiner's half ($Z < 0$) using $(X, Z) \to (-X, -Z)$. Both players observe identical obstacles and multipliers ahead of them in identical relative positions from their own tank's POV!
- **Route Widening (16m - 32m):** Room creator chooses the track width:
  - **16m Narrow (3 Lanes):** Tight bottleneck combat.
  - **20m Standard (4 Lanes):** Classic tournament duel.
  - **26m Wide (6 Lanes):** Multiplier rush with large sweeping crowds.
  - **32m Super Wide (8 Lanes):** Massive high-density mob battles.
  - The road mesh, dashed highway lines, cannon steering range, and fortress scale dynamically with the chosen route width.
- **Interactive Drag & Drop Arena Level Designer:** Drag any obstacle chip from the bottom drawer directly onto your half of the track, or drag placed items to reposition them. Live placement ghosts and twin mirror previews update in real time.
- **Individual Tank POV Camera:** Both players see their **own tank at the bottom of the screen**, aiming forward up the track towards the opponent's fortified base!
- **Responsive Display for Android & Laptops:**
  - **Laptops / Desktops:** Centered rectangular arcade frame with aspect ratio toggle (`📱 Phone` / `💻 Wide`) and native fullscreen toggle (`⛶ Fullscreen`).
  - **Android / Mobile:** Edge-to-edge fullscreen (`100vw` × `100dvh`), `touch-action: none` gesture controls, and thumb slider steering.
- **All 14 Hazards, Barriers & Active Combat Threats.**
- **Robust 4-System Netcode Layer:** Host-authoritative arbiter (400ms guest pending resolution), NTP clock sync, deterministic timestamped trajectory advancement, and 1.0Hz state healing.

---

## 🎮 Streamlined User Flow

1. **Player A (Host):**
   - Opens the game in any modern browser on PC, tablet, or phone.
   - Clicks **"🛠️ CREATE ROOM & DESIGN ARENA"**.
   - **Selects Route Width:** Chooses 16m, 20m, 26m, or 32m with 1 click.
   - **Designs Creator Half ($Z > 0$):**
     - **Drag from Palette:** Press and drag any multiplier or obstacle chip from the bottom drawer onto your half.
     - **Auto-Mirroring:** The opponent's half ($Z < 0$) automatically mirrors every item in real time, guaranteeing 100% fair duels.
     - **1-Click Presets:** *Gauntlet (20m), Multiplier Rush (26m), Chaos Canyon (20m), Blank Track*.
   - Sets Room Code (e.g., `CANNON-882`).
   - Clicks **"✅ OK - CREATE ROOM & WAIT FOR PLAYER"** $\rightarrow$ enters Waiting Room with **"📋 Copy Code"** button.

2. **Player B (Guest):**
   - Opens the game on their device.
   - Clicks **"🔑 ENTER ROOM CODE"**, types the Host's code (e.g., `CANNON-882`), and clicks **"🚀 JOIN MATCH"**.

3. **Synchronized 1v1 Match:**
   - Host automatically transmits the custom designed symmetric arena layout (`MAP_SYNC`) with route width.
   - 4-Ping NTP clock synchronization locks the match clock.
   - 3..2..1 countdown synchronizes, and both players play from their **own tank POV** (Host = Blue Tank at bottom; Guest = Red Tank at bottom).

---

## 📐 Mathematical POV Symmetry Verification

When Host places an element at $(X, Z)$ relative to their cannon at $(0, 48)$:
- Relative distance ahead: $dZ = 48 - Z$
- Relative horizontal offset: $dX = X$ (negative is left, positive is right)

The point-reflection generator places the twin element at $(-X, -Z)$ on Guest's half:
- Guest cannon is at $(0, -48)$ looking towards $+Z$.
- Guest camera projection maps $relX = -(-X) = X$ and $relZ = -Z - (-48) = 48 - Z$.
- Result: Guest observes the twin element at the **exact same distance ahead** and on the **exact same side of their screen**!

---

## 🧪 Verification

Run the deterministic test suite:
```bash
python verify_netcode.py
```
```
✓ System 1 PASS: Host-Authoritative Win/Loss Arbiter (Guest 400ms pending resolution)
✓ System 2 PASS: 4-Ping NTP Clock Handshake locks global match clock
✓ System 3 PASS: Deterministic 3D Trajectory Advancement (clamped 300ms)
✓ System 4 PASS: Checksum State Healing aligns base HP smoothly
✓ System 5 PASS: Symmetric Half-Map POV Reflection & Route Widening (16m - 32m)
>>> ALL 5 SYSTEMS VERIFIED IN FULL ACCORDANCE WITH SPECIFICATION <<<
```
