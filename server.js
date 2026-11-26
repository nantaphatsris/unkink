const osc = require("osc");
const WebSocket = require("ws");

const PORT = 8080;
const MAX_PLAYERS = 10;

// สีเส้นขอบประจำ Player ID (RGB 0-1) คงที่และไม่ซ้ำกัน
const PLAYER_OUTLINE_COLORS = {
    1:  { r: 1.00, g: 0.20, b: 0.20 }, // red
    2:  { r: 0.10, g: 0.75, b: 1.00 }, // cyan
    3:  { r: 0.20, g: 1.00, b: 0.35 }, // green
    4:  { r: 1.00, g: 0.75, b: 0.10 }, // amber
    5:  { r: 0.75, g: 0.25, b: 1.00 }, // purple
    6:  { r: 1.00, g: 0.30, b: 0.70 }, // pink
    7:  { r: 0.20, g: 1.00, b: 0.90 }, // turquoise
    8:  { r: 1.00, g: 0.50, b: 0.12 }, // orange
    9:  { r: 0.65, g: 1.00, b: 0.15 }, // lime
    10: { r: 0.45, g: 0.55, b: 1.00 }  // periwinkle
};

// ========================================
// OSC -> TouchDesigner
// ========================================

const udpPort = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: 9001,
    remoteAddress: "127.0.0.1",
    remotePort: 9000
});

let oscReady = false;

udpPort.on("ready", () => {
    oscReady = true;
    renderDashboard("OSC READY (TouchDesigner: 127.0.0.1:9000)");
});

udpPort.on("error", (err) => {
    console.error("OSC ERROR:", err.message);
});

udpPort.open();

function sendOSC(address, type, value) {
    if (!oscReady) return;
    udpPort.send({
        address,
        args: [{ type, value }]
    });
}

function sendPlayerOutlineColor(playerId) {
    const color = PLAYER_OUTLINE_COLORS[playerId];
    if (!color) return;

    sendOSC(`/player/${playerId}/outline/r`, "f", color.r);
    sendOSC(`/player/${playerId}/outline/g`, "f", color.g);
    sendOSC(`/player/${playerId}/outline/b`, "f", color.b);
}

function cleanPlayerName(value, fallback) {
    const name = String(value ?? "")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 24);
    return name || fallback;
}

// ========================================
// PLAYER MANAGEMENT & CMD DASHBOARD
// ========================================

const occupiedSlots = new Map(); // เก็บ { playerId => ws }
const recentLogs = [];

function formatPlayerLabel(ws) {
    if (!ws || !ws.playerId) return "Unknown";
    return ws.playerName && ws.playerName !== `Player ${ws.playerId}`
        ? `Player ${ws.playerId} (${ws.playerName})`
        : `Player ${ws.playerId}`;
}

function renderDashboard(eventMessage = null) {
    if (eventMessage) {
        const time = new Date().toLocaleTimeString("th-TH", { hour12: false });
        recentLogs.push(`[${time}] ${eventMessage}`);
        if (recentLogs.length > 8) recentLogs.shift(); // เก็บประวัติล่าสุด 8 บรรทัด
    }

    console.clear();
    console.log("==================================================");
    console.log("       NIGHT SKY MULTIPLAYER SERVER (CMD)         ");
    console.log("==================================================");
    console.log(`WebSocket Port: ${PORT} | Active Players: ${occupiedSlots.size}/${MAX_PLAYERS}`);
    console.log("--------------------------------------------------");
    console.log(" SLOT | STATUS       | PLAYER NAME");
    console.log("--------------------------------------------------");

    for (let i = 1; i <= MAX_PLAYERS; i++) {
        const client = occupiedSlots.get(i);
        const slotStr = ` P${String(i).padStart(2, "0")} `;

        if (!client) {
            console.log(`${slotStr} | ⚪ Available       | -`);
        } else {
            const camStatus = client.isCameraActive ? "🟢 Open Camera  " : "🟡 Waiting";
            const displayName = client.playerName || `Player ${i}`;
            console.log(`${slotStr} | ${camStatus} | ${displayName}`);
        }
    }

    console.log("--------------------------------------------------");
    console.log(" Recent Events:");
    if (recentLogs.length === 0) {
        console.log("  - waiting player connect...");
    } else {
        recentLogs.forEach(log => console.log(`  ${log}`));
    }
    console.log("==================================================");
}

function allocatePlayer(ws) {
    for (let i = 1; i <= MAX_PLAYERS; i++) {
        if (!occupiedSlots.has(i)) {
            occupiedSlots.set(i, ws);
            return i;
        }
    }
    return null;
}

function releasePlayer(ws) {
    const id = ws.playerId;
    if (!id) return;

    const label = formatPlayerLabel(ws);

    sendOSC(`/player/${id}/active`, "i", 0);
    sendOSC(`/player/${id}/name`, "s", "");

    occupiedSlots.delete(id);
    ws.playerId = null;
    renderDashboard(`${label} disconnect`);
}

// ========================================
// WEBSOCKET SERVER
// ========================================

const wss = new WebSocket.Server({ port: PORT });

wss.on("listening", () => {
    renderDashboard(`Server started on port ${PORT}`);
});

wss.on("connection", (ws) => {
    const playerId = allocatePlayer(ws);

    if (playerId === null) {
        ws.send(JSON.stringify({
            type: "error",
            message: "Full"
        }));
        ws.close(1013, "Server full");
        return;
    }

    ws.playerId = playerId;
    ws.playerName = `Player ${playerId}`;
    ws.isCameraActive = false;
    ws.isAlive = true;

    renderDashboard(`Player ${playerId} connect`);

    // เริ่มต้น inactive และส่งข้อมูลสีขอบประจำ ID ให้ TD
    sendOSC(`/player/${playerId}/active`, "i", 0);
    sendPlayerOutlineColor(playerId);
    sendOSC(`/player/${playerId}/name`, "s", ws.playerName);

    ws.send(JSON.stringify({
        type: "welcome",
        playerId,
        displayName: ws.playerName,
        outlineColor: PLAYER_OUTLINE_COLORS[playerId]
    }));

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    // ========================================
    // RECEIVE WEBSITE MESSAGES
    // ========================================

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);

            // PLAYER DISPLAY NAME
            if (data.type === "name") {
                ws.playerName = cleanPlayerName(data.name, `Player ${playerId}`);
                sendOSC(`/player/${playerId}/name`, "s", ws.playerName);
                renderDashboard(`Player ${playerId} rename "${ws.playerName}"`);
                return;
            }

            // CAMERA ACTIVE / INACTIVE
            if (data.type === "active") {
                const active = data.active ? 1 : 0;
                ws.isCameraActive = Boolean(active);
                sendOSC(`/player/${playerId}/active`, "i", active);
                const stateText = active ? "Active Camera" : "Inactive Animation";
                renderDashboard(`${formatPlayerLabel(ws)} -> ${stateText}`);
                return;
            }

            // PLAYER X/Y
            if (data.type === "xy") {
                const x = Number(data.x);
                const y = Number(data.y);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return;

                const safeX = Math.max(0, Math.min(1, x));
                const safeY = Math.max(0, Math.min(1, y));
                sendOSC(`/player/${playerId}/x`, "f", safeX);
                sendOSC(`/player/${playerId}/y`, "f", safeY);
                return;
            }

            // RUN CONSTELLATION ANIMATION (ระบบเดิม)
            if (data.type === "runAnimation") {
                renderDashboard(`${formatPlayerLabel(ws)} กดเล่นอนิเมชัน`);
                sendOSC("/animation/run", "i", 1);
                setTimeout(() => {
                    sendOSC("/animation/run", "i", 0);
                }, 100);
                return;
            }

        } catch (error) {
            console.error("Invalid message:", error.message);
        }
    });

    ws.on("close", () => releasePlayer(ws));

    ws.on("error", (err) => {
        renderDashboard(`${formatPlayerLabel(ws)} เกิดข้อผิดพลาด: ${err.message}`);
    });
});

// ========================================
// CONNECTION WATCHDOG
// ========================================

const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 15000);

wss.on("close", () => clearInterval(heartbeat));
