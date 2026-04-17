import {
    createInitialCubeState,
    createInitialState,
    getClaimUnitForFaceCell,
    getFaceBoard,
    generateRoomId,
    isValidRoomId,
    type ClientMessage,
    type ClaimUnitId,
    type CubeFace,
    type CubeGameState,
    type GameMode,
    type GameState,
    type Mark,
    type PlayerMarks,
    type Role,
    type ServerMessage,
} from "../shared";

// === Module-level state ===

interface PresenceState {
    player1Connected: boolean;
    player2Connected: boolean;
    reconnectingRole: Role | null;
    reconnectDeadlineMs: number | null;
}

const RECONNECT_TOKEN_STORAGE_PREFIX = "ttt:reconnect:";
const CUBE_FACES: ReadonlyArray<CubeFace> = ["U", "R", "F", "D", "L", "B"];
const FACE_CELL_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
const FACE_SNAP_ROTATION: Record<CubeFace, { x: number; y: number }> = {
    F: { x: 0, y: 0 },
    R: { x: 0, y: -90 },
    B: { x: 0, y: 180 },
    L: { x: 0, y: 90 },
    U: { x: -90, y: 0 },
    D: { x: 90, y: 0 },
};
const CORNER_SNAP_ROTATION: Partial<Record<ClaimUnitId, { x: number; y: number }>> = {
    URF: { x: -35, y: -45 },
    UFL: { x: -35, y: 45 },
    ULB: { x: -35, y: 135 },
    UBR: { x: -35, y: -135 },
    DFR: { x: 35, y: -45 },
    DLF: { x: 35, y: 45 },
    DBL: { x: 35, y: 135 },
    DRB: { x: 35, y: -135 },
};
const EDGE_SNAP_ROTATION: Partial<Record<ClaimUnitId, { x: number; y: number }>> = {
    UF: { x: -45, y: 0 },
    UR: { x: -45, y: -90 },
    UB: { x: -45, y: 180 },
    UL: { x: -45, y: 90 },
    FR: { x: 0, y: -45 },
    FL: { x: 0, y: 45 },
    BR: { x: 0, y: -135 },
    BL: { x: 0, y: 135 },
    DF: { x: 45, y: 0 },
    DR: { x: 45, y: -90 },
    DB: { x: 45, y: 180 },
    DL: { x: 45, y: 90 },
};
const CENTER_PAIR_FOCUS_FACE: Partial<Record<ClaimUnitId, CubeFace>> = {
    UD: "U",
    RL: "R",
    FB: "F",
};
type LocalGameState = GameState | CubeGameState;

function normalizeBaseUrl(rawBaseUrl: string): string {
    const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
    if (!trimmed) {
        return "";
    }

    if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
        return trimmed;
    }

    if (trimmed.startsWith("http://")) {
        return `ws://${trimmed.slice("http://".length)}`;
    }

    if (trimmed.startsWith("https://")) {
        return `wss://${trimmed.slice("https://".length)}`;
    }

    return trimmed;
}

function resolveWebSocketUrl(roomId: string): string {
    // @ts-ignore
    const envBaseUrl = String(import.meta.env.VITE_WS_BASE_URL ?? "");
    const configuredBaseUrl = normalizeBaseUrl(envBaseUrl);
    if (configuredBaseUrl) {
        return `${configuredBaseUrl}/${roomId}`;
    }

    // In local Vite dev, the app runs on :5173 while WS server runs on :8080.
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
        return `ws://localhost:8080/${roomId}`;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}/${roomId}`;
}

let roomMode: GameMode = "classic";
let state: LocalGameState = createInitialState();
let role: Role | null = null;
let presence: PresenceState = {
    player1Connected: false,
    player2Connected: false,
    reconnectingRole: null,
    reconnectDeadlineMs: null,
};
let playerMarks: PlayerMarks = { player1: "X", player2: "O" };
let lastError: string | null = null;
let socket: WebSocket | null = null;
let currentRoomId: string | null = null;
let landingNotice: string | null = null;
let selectedLandingMode: GameMode = "cube";
let activeCubeFace: CubeFace = "F";
let cubeRotationX = -24;
let cubeRotationY = -30;
let previousCubeState: CubeGameState | null = null;
let recentCubeCellKeys = new Set<string>();
let rematchVotes = { player1Voted: false, player2Voted: false };
let pendingCubeMoveFace: CubeFace | null = null;
let isCubeRulesOpen = false;

function cubeCellKey(face: CubeFace, cellIndex: number): string {
    return `${face}:${cellIndex}`;
}

function normalizeAngle(angle: number): number {
    let normalized = angle % 360;
    if (normalized > 180) normalized -= 360;
    if (normalized < -180) normalized += 360;
    return normalized;
}

function angleDistance(a: number, b: number): number {
    return Math.abs(normalizeAngle(a - b));
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

interface Vec3 {
    x: number;
    y: number;
    z: number;
}

interface CubeHit {
    face: CubeFace;
    cellIndex: number;
}

const CUBE_HALF = 120;
const CUBE_EPSILON = 1e-5;

function rotateAroundY(vector: Vec3, degrees: number): Vec3 {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: vector.x * cos + vector.z * sin,
        y: vector.y,
        z: -vector.x * sin + vector.z * cos,
    };
}

function rotateAroundX(vector: Vec3, degrees: number): Vec3 {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: vector.x,
        y: vector.y * cos - vector.z * sin,
        z: vector.y * sin + vector.z * cos,
    };
}

function worldToCubeLocal(world: Vec3): Vec3 {
    // CSS transform is rotateX(...) rotateY(...), so inverse applies X then Y with negative angles.
    const xUnrotated = rotateAroundX(world, -cubeRotationX);
    return rotateAroundY(xUnrotated, -cubeRotationY);
}

function axisToCellCoord(value: number): number {
    const normalized = (value + CUBE_HALF) / (CUBE_HALF * 2);
    const index = Math.floor(normalized * 3);
    return clamp(index, 0, 2);
}

function faceAndCellFromHitPoint(hit: Vec3): CubeHit | null {
    const nearX = Math.abs(Math.abs(hit.x) - CUBE_HALF) <= 0.01;
    const nearY = Math.abs(Math.abs(hit.y) - CUBE_HALF) <= 0.01;
    const nearZ = Math.abs(Math.abs(hit.z) - CUBE_HALF) <= 0.01;

    if (nearZ) {
        if (hit.z > 0) {
            const row = axisToCellCoord(hit.y);
            const col = axisToCellCoord(hit.x);
            return { face: "F", cellIndex: row * 3 + col };
        }

        const row = axisToCellCoord(hit.y);
        const col = axisToCellCoord(-hit.x);
        return { face: "B", cellIndex: row * 3 + col };
    }

    if (nearX) {
        if (hit.x > 0) {
            const row = axisToCellCoord(hit.y);
            const col = axisToCellCoord(-hit.z);
            return { face: "R", cellIndex: row * 3 + col };
        }

        const row = axisToCellCoord(hit.y);
        const col = axisToCellCoord(hit.z);
        return { face: "L", cellIndex: row * 3 + col };
    }

    if (nearY) {
        if (hit.y < 0) {
            const row = axisToCellCoord(hit.z);
            const col = axisToCellCoord(hit.x);
            return { face: "U", cellIndex: row * 3 + col };
        }

        const row = axisToCellCoord(-hit.z);
        const col = axisToCellCoord(hit.x);
        return { face: "D", cellIndex: row * 3 + col };
    }

    return null;
}

function raycastCubeCell(scene: HTMLElement, clientX: number, clientY: number): CubeHit | null {
    const rect = scene.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const pointerX = clientX - centerX;
    const pointerY = clientY - centerY;

    const perspectiveRaw = getComputedStyle(scene).perspective;
    const perspective = Number.parseFloat(perspectiveRaw);
    const cameraZ = Number.isFinite(perspective) ? perspective : 900;

    const worldRayOrigin: Vec3 = { x: 0, y: 0, z: cameraZ };
    const worldRayDirection: Vec3 = { x: pointerX, y: pointerY, z: -cameraZ };

    const rayOrigin = worldToCubeLocal(worldRayOrigin);
    const rayDirection = worldToCubeLocal(worldRayDirection);

    let tMin = Number.NEGATIVE_INFINITY;
    let tMax = Number.POSITIVE_INFINITY;
    const axes: Array<keyof Vec3> = ["x", "y", "z"];

    for (const axis of axes) {
        const origin = rayOrigin[axis];
        const direction = rayDirection[axis];

        if (Math.abs(direction) < CUBE_EPSILON) {
            if (origin < -CUBE_HALF || origin > CUBE_HALF) {
                return null;
            }
            continue;
        }

        const t1 = (-CUBE_HALF - origin) / direction;
        const t2 = (CUBE_HALF - origin) / direction;
        const near = Math.min(t1, t2);
        const far = Math.max(t1, t2);
        tMin = Math.max(tMin, near);
        tMax = Math.min(tMax, far);

        if (tMin > tMax) {
            return null;
        }
    }

    const hitT = tMin >= 0 ? tMin : tMax;
    if (hitT < 0 || !Number.isFinite(hitT)) {
        return null;
    }

    const hitPoint: Vec3 = {
        x: rayOrigin.x + rayDirection.x * hitT,
        y: rayOrigin.y + rayDirection.y * hitT,
        z: rayOrigin.z + rayDirection.z * hitT,
    };

    return faceAndCellFromHitPoint(hitPoint);
}

function applyCubeRotation(cube: HTMLElement, smooth = true): void {
    cube.style.transition = smooth ? "transform 220ms ease" : "none";
    cube.style.transform = `rotateX(${cubeRotationX}deg) rotateY(${cubeRotationY}deg)`;
}

function snapCubeToRotation(rotation: { x: number; y: number }, smooth = true): void {
    cubeRotationX = rotation.x;
    cubeRotationY = rotation.y;
    activeCubeFace = nearestFaceForRotation(cubeRotationX, cubeRotationY);
    const cube = document.querySelector<HTMLElement>(".cube");
    if (cube) {
        applyCubeRotation(cube, smooth);
    }
}

function nearestFaceForRotation(rotationX: number, rotationY: number): CubeFace {
    let nearest: CubeFace = "F";
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const face of CUBE_FACES) {
        const target = FACE_SNAP_ROTATION[face];
        const distance = angleDistance(rotationX, target.x) + angleDistance(rotationY, target.y);
        if (distance < bestDistance) {
            bestDistance = distance;
            nearest = face;
        }
    }

    return nearest;
}

function clearRecentCubeHighlights(): void {
    recentCubeCellKeys = new Set<string>();
}

function markRecentCubeHighlights(keys: string[]): void {
    recentCubeCellKeys = new Set(keys);
}

function findChangedClaimUnits(previous: CubeGameState | null, nextState: CubeGameState): ClaimUnitId[] {
    if (!previous) {
        return [];
    }

    const changed: ClaimUnitId[] = [];
    for (const claimId in nextState.claims) {
        const typedClaimId = claimId as ClaimUnitId;
        if (previous.claims[typedClaimId] !== nextState.claims[typedClaimId]) {
            changed.push(typedClaimId);
        }
    }

    return changed;
}

function projectedCellsForClaimUnits(
    cubeState: CubeGameState,
    claimUnitIds: ClaimUnitId[],
    newlyClaimedFaces: ReadonlySet<CubeFace>,
): Array<{ face: CubeFace; cellIndex: number }> {
    const lookup = new Set(claimUnitIds);
    const projected: Array<{ face: CubeFace; cellIndex: number }> = [];

    for (const face of CUBE_FACES) {
        if (cubeState.claimedFaces[face] && !newlyClaimedFaces.has(face)) {
            continue;
        }

        for (const cellIndex of FACE_CELL_INDICES) {
            const unit = getClaimUnitForFaceCell(face, cellIndex);
            if (unit && lookup.has(unit)) {
                projected.push({ face, cellIndex });
            }
        }
    }

    return projected;
}

function focusFaceForProjectedCells(projectedCells: Array<{ face: CubeFace; cellIndex: number }>): CubeFace | null {
    if (projectedCells.length === 0) {
        return null;
    }

    if (projectedCells.some((cell) => cell.face === activeCubeFace)) {
        return activeCubeFace;
    }

    return projectedCells[0].face;
}

function rotationForChangedUnits(
    changedUnits: ClaimUnitId[],
    projectedCells: Array<{ face: CubeFace; cellIndex: number }>,
    preferredFace: CubeFace | null,
): { x: number; y: number } | null {
    const latestUnit = changedUnits[changedUnits.length - 1];
    if (!latestUnit) {
        return null;
    }

    const cornerRotation = CORNER_SNAP_ROTATION[latestUnit];
    if (cornerRotation) {
        return cornerRotation;
    }

    const edgeRotation = EDGE_SNAP_ROTATION[latestUnit];
    if (edgeRotation) {
        return edgeRotation;
    }

    const centerFace = CENTER_PAIR_FOCUS_FACE[latestUnit];
    if (centerFace) {
        if (preferredFace && projectedCells.some((cell) => cell.face === preferredFace)) {
            return FACE_SNAP_ROTATION[preferredFace];
        }
        return FACE_SNAP_ROTATION[centerFace];
    }

    const fallbackFace = focusFaceForProjectedCells(projectedCells);
    return fallbackFace ? FACE_SNAP_ROTATION[fallbackFace] : null;
}

function handleCubeStateSync(nextState: CubeGameState): void {
    // Reset snapshots should clear prior-game highlights
    if (nextState.moveCount === 0) {
        pendingCubeMoveFace = null;
        clearRecentCubeHighlights();
        previousCubeState = nextState;
        return;
    }

    const changedUnits = findChangedClaimUnits(previousCubeState, nextState);
    if (changedUnits.length > 0) {
        const newlyClaimedFaces = new Set<CubeFace>();
        if (previousCubeState) {
            for (const face of CUBE_FACES) {
                if (!previousCubeState.claimedFaces[face] && nextState.claimedFaces[face]) {
                    newlyClaimedFaces.add(face);
                }
            }
        }

        const projected = projectedCellsForClaimUnits(nextState, changedUnits, newlyClaimedFaces);
        markRecentCubeHighlights(projected.map((cell) => cubeCellKey(cell.face, cell.cellIndex)));
        const preferredFace = pendingCubeMoveFace ?? nextState.lastMoveFace;
        const targetRotation = rotationForChangedUnits(changedUnits, projected, preferredFace);
        if (targetRotation) {
            // Keep auto-focus immediate to avoid interaction lock after move sync
            snapCubeToRotation(targetRotation, false);
        }
    }

    pendingCubeMoveFace = null;
    previousCubeState = nextState;
}

// === Transport ===

function send(message: ClientMessage): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

function reconnectTokenKey(roomId: string): string {
    return `${RECONNECT_TOKEN_STORAGE_PREFIX}${roomId}`;
}

function getReconnectToken(roomId: string): string | undefined {
    try {
        const token = window.localStorage.getItem(reconnectTokenKey(roomId));
        return token ?? undefined;
    } catch {
        return undefined;
    }
}

function setReconnectToken(roomId: string, token: string): void {
    try {
        window.localStorage.setItem(reconnectTokenKey(roomId), token);
    } catch {
        // Ignore storage failures and continue without reconnect persistence
    }
}

function returnToLanding(notice: string | null, skipPushState = false): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
    }
    socket = null;
    currentRoomId = null;
    role = null;
    roomMode = "classic";
    state = createInitialState();
    previousCubeState = null;
    clearRecentCubeHighlights();
    isCubeRulesOpen = false;
    playerMarks = { player1: "X", player2: "O" };
    rematchVotes = { player1Voted: false, player2Voted: false };
    presence = { player1Connected: false, player2Connected: false, reconnectingRole: null, reconnectDeadlineMs: null };
    lastError = null;
    landingNotice = notice;
    if (!skipPushState) {
        history.pushState(null, "", "/");
    }
    renderLanding();
}

function connectToRoom(roomId: string, modeForNewRoom?: GameMode): void {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
    }

    currentRoomId = roomId;
    roomMode = modeForNewRoom ?? "classic";
    state = roomMode === "classic" ? createInitialState() : createInitialCubeState();
    previousCubeState = null;
    clearRecentCubeHighlights();
    isCubeRulesOpen = false;
    activeCubeFace = "F";
    cubeRotationX = -24;
    cubeRotationY = -30;
    playerMarks = { player1: "X", player2: "O" };
    rematchVotes = { player1Voted: false, player2Voted: false };
    role = null;
    presence = { player1Connected: false, player2Connected: false, reconnectingRole: null, reconnectDeadlineMs: null };
    lastError = null;
    landingNotice = null;

    history.pushState(null, "", `/${roomId}`);

    socket = new WebSocket(resolveWebSocketUrl(roomId));
    const thisSocket = socket;
    const reconnectToken = getReconnectToken(roomId);

    socket.addEventListener("open", () => {
        if (socket !== thisSocket) return;
        const joinMessage: ClientMessage = modeForNewRoom
            ? { type: "join", reconnectToken, mode: modeForNewRoom }
            : { type: "join", reconnectToken };
        send(joinMessage);
        renderGame(state);
    });

    socket.addEventListener("close", () => {
        if (socket !== thisSocket) return;
        if (!currentRoomId) {
            return;
        }
        role = null;
        renderGame(state);
    });

    socket.addEventListener("error", () => {
        if (socket !== thisSocket) return;
        lastError = "Unable to connect to server";
        renderGame(state);
    });

    socket.addEventListener("message", (event) => {
        if (socket !== thisSocket) return;
        let message: ServerMessage;
        try {
            const raw: unknown = JSON.parse(String(event.data));
            if (typeof raw !== "object" || raw === null || typeof (raw as { type?: unknown }).type !== "string") {
                return;
            }
            message = raw as ServerMessage;
        } catch {
            return;
        }

        if (message.type === "role_assigned") {
            role = message.role;
            if (currentRoomId) {
                setReconnectToken(currentRoomId, message.reconnectToken);
            }
            lastError = null;
        }

        if (message.type === "presence") {
            presence = {
                player1Connected: message.player1Connected,
                player2Connected: message.player2Connected,
                reconnectingRole: message.reconnectingRole,
                reconnectDeadlineMs: message.reconnectDeadlineMs,
            };
        }

        if (message.type === "state_sync") {
            roomMode = message.mode;
            state = message.state;
            playerMarks = message.playerMarks;
            if (message.mode === "cube") {
                handleCubeStateSync(message.state);
            } else {
                previousCubeState = null;
                clearRecentCubeHighlights();
            }
            if (message.state.moveCount === 0) {
                rematchVotes = { player1Voted: false, player2Voted: false };
            }
            lastError = null;
        }

        if (message.type === "rematch_pending") {
            rematchVotes = { player1Voted: message.player1Voted, player2Voted: message.player2Voted };
        }

        if (message.type === "error") {
            if (message.error === "ROOM_NOT_FOUND") {
                returnToLanding("That room doesn't exist.", true);
                return;
            }
            lastError = friendlyErrorMessage(message.error);
        }

        if (message.type === "room_closed") {
            returnToLanding("Opponent did not reconnect in time. Room closed.");
            return;
        }

        renderGame(state);
    });

    renderGame(state);
}

// === Status helper ===

function bothConnected(): boolean {
    return presence.player1Connected && presence.player2Connected;
}

function getPlayerLabel(playerRole: Role): string {
    return playerRole === "player1" ? "Player 1" : "Player 2";
}

function getAssignedMark(playerRole: Role | null): Mark | null {
    if (!playerRole) {
        return null;
    }

    return playerMarks[playerRole];
}

function getPlayerForMark(mark: Mark | null): Role | null {
    if (mark === null) {
        return null;
    }

    return playerMarks.player1 === mark ? "player1" : "player2";
}

function reconnectSecondsLeft(): number | null {
    if (presence.reconnectDeadlineMs === null) {
        return null;
    }

    const diffMs = presence.reconnectDeadlineMs - Date.now();
    if (diffMs <= 0) {
        return 0;
    }

    return Math.ceil(diffMs / 1000);
}

function friendlyErrorMessage(errorCode: string): string {
    switch (errorCode) {
        case "ROOM_FULL":
            return "That room is already full.";
        case "NOT_SEATED":
            return "You are not assigned to this game.";
        case "INVALID_MESSAGE":
            return "That action is not valid right now.";
        case "INVALID_ROOM":
            return "That room code is invalid.";
        case "MODE_MISMATCH":
            return "That room is using a different game mode.";
        case "OUT_OF_BOUNDS":
            return "That move is outside the board.";
        case "CELL_OCCUPIED":
            return "That spot is already taken.";
        case "GAME_OVER":
            return "The game has already ended.";
        case "NOT_YOUR_TURN":
            return "It is not your turn yet.";
        case "OPENING_CORNER_FORBIDDEN":
            return "X cannot start on a corner. Choose an edge or center.";
        case "FACE_CLAIMED":
            return "That face is inactive.";
        default:
            return "Something went wrong. Please try again.";
    }
}

function getStatusMessage(s: LocalGameState): string {
    if (!socket || socket.readyState !== WebSocket.OPEN) return "Connecting to server...";
    if (!role) return "Joining room...";
    if (presence.reconnectingRole && role !== presence.reconnectingRole) {
        const secondsLeft = reconnectSecondsLeft();
        return `Opponent disconnected. Waiting ${secondsLeft ?? "?"}s for reconnect...`;
    }
    if (!bothConnected()) {
        const assignedMark = getAssignedMark(role);
        return `You are ${getPlayerLabel(role)}${assignedMark ? ` (${assignedMark})` : ""}. Waiting for opponent...`;
    }

    if (roomMode === "cube") {
        const cubeState = s as CubeGameState;
        if (cubeState.status === "won" && cubeState.winner) {
            return `${getPlayerLabel(cubeState.winner)} wins the match!`;
        }
        if (cubeState.status === "won") {
            return "It's a draw.";
        }

        const myMark = getAssignedMark(role);
        return cubeState.currentPlayer === myMark ? "Your turn" : `Opponent's turn (${cubeState.currentPlayer})`;
    }

    const classicState = s as GameState;
    if (classicState.status === "won") {
        const winningPlayer = getPlayerForMark(classicState.winner);
        return winningPlayer ? `${getPlayerLabel(winningPlayer)} wins! 🎉` : `Player ${classicState.winner} wins! 🎉`;
    }
    if (classicState.status === "draw") return "It's a draw!";
    const myMark = getAssignedMark(role);
    if (classicState.currentPlayer === myMark) {
        return `Your turn`;
    }
    return `Opponent's turn (${classicState.currentPlayer})`;
}

function canPlayTurn(s: LocalGameState): boolean {
    return (
        socket?.readyState === WebSocket.OPEN &&
        role !== null &&
        bothConnected() &&
        s.status === "in_progress" &&
        s.currentPlayer === getAssignedMark(role)
    );
}

// === Game screen ===

function renderGame(s: LocalGameState): void {
    const app = document.getElementById("app")!;
    app.innerHTML = "";

    // Header controls
    const headerControls = document.getElementById("header-controls")!;
    headerControls.innerHTML = "";

    const roomLabel = document.createElement("span");
    roomLabel.id = "header-room-label";
    roomLabel.textContent = `Room: ${currentRoomId}`;
    headerControls.appendChild(roomLabel);

    const copyBtn = document.createElement("button");
    copyBtn.id = "copy-link";
    copyBtn.textContent = "Copy link";
    copyBtn.addEventListener("click", () => {
        void navigator.clipboard.writeText(window.location.href).then(() => {
            copyBtn.textContent = "Copied!";
            setTimeout(() => {
                copyBtn.textContent = "Copy link";
            }, 1500);
        });
    });
    headerControls.appendChild(copyBtn);

    // Status
    const status = document.createElement("p");
    status.id = "status";
    status.textContent = getStatusMessage(s);
    app.appendChild(status);

    // Inline error
    const error = document.createElement("p");
    error.id = "error";
    error.setAttribute("role", "alert");
    if (lastError) {
        error.textContent = `Error: ${lastError}`;
    }
    app.appendChild(error);

    // Rematch bar - shown only when game is over
    if (s.status !== "in_progress" && role !== null && bothConnected()) {
        const myVoted = role === "player1" ? rematchVotes.player1Voted : rematchVotes.player2Voted;
        const theirVoted = role === "player1" ? rematchVotes.player2Voted : rematchVotes.player1Voted;

        const rematchBar = document.createElement("div");
        rematchBar.id = "rematch-bar";

        if (!myVoted) {
            const rematchBtn = document.createElement("button");
            rematchBtn.id = "rematch-btn";
            rematchBtn.textContent = "Rematch?";
            rematchBtn.addEventListener("click", () => send({ type: "rematch" }));
            rematchBar.appendChild(rematchBtn);
        } else if (!theirVoted) {
            const waiting = document.createElement("span");
            waiting.id = "rematch-waiting";
            waiting.textContent = "Waiting for opponent to rematch…";
            rematchBar.appendChild(waiting);
        }

        app.appendChild(rematchBar);
    }

    if (roomMode === "classic") {
        const classicState = s as GameState;
        const board = document.createElement("div");
        board.id = "board";

        for (let i = 0; i < 9; i += 1) {
            const cell = document.createElement("button");
            cell.className = "cell";

            const mark = classicState.board[i];
            if (mark !== null) {
                cell.textContent = mark;
                cell.classList.add(mark.toLowerCase());
            }

            if (classicState.winningLine?.includes(i)) {
                cell.classList.add("winning");
            }

            if (mark !== null || !canPlayTurn(classicState)) {
                cell.disabled = true;
            }

            cell.addEventListener("click", () => send({ type: "move", cellIndex: i }));
            board.appendChild(cell);
        }

        app.appendChild(board);
    } else {
        const cubeState = s as CubeGameState;

        const cubeHeader = document.createElement("div");
        cubeHeader.className = "cube-meta-row";

        const cubeMeta = document.createElement("div");
        cubeMeta.className = "cube-meta";

        const player1Score = document.createElement("span");
        player1Score.className = `cube-score${role === "player1" ? " active-player" : ""}`;
        player1Score.textContent = `${getPlayerLabel("player1")}: ${cubeState.faceClaimCounts.player1}/6 faces`;

        const divider = document.createElement("span");
        divider.className = "cube-score-divider";
        divider.textContent = "|";

        const player2Score = document.createElement("span");
        player2Score.className = `cube-score${role === "player2" ? " active-player" : ""}`;
        player2Score.textContent = `${getPlayerLabel("player2")}: ${cubeState.faceClaimCounts.player2}/6 faces`;

        cubeMeta.appendChild(player1Score);
        cubeMeta.appendChild(divider);
        cubeMeta.appendChild(player2Score);

        cubeHeader.appendChild(cubeMeta);
        app.appendChild(cubeHeader);

        const rulesButton = document.createElement("button");
        rulesButton.className = "rules-btn";
        rulesButton.textContent = "Rules";
        rulesButton.addEventListener("click", () => {
            isCubeRulesOpen = true;
            renderGame(state);
        });

        headerControls.appendChild(rulesButton);

        const faceHint = document.createElement("p");
        faceHint.className = "cube-help";
        const assignedMark = getAssignedMark(role);
        faceHint.textContent = assignedMark ? `Playing as ${assignedMark}` : "";
        app.appendChild(faceHint);

        const scene = document.createElement("div");
        scene.className = "cube-scene";

        const cube = document.createElement("div");
        cube.className = "cube";
        applyCubeRotation(cube, true);

        const canPlay = canPlayTurn(cubeState);
        const cellElements = new Map<string, HTMLButtonElement>();

        for (const face of CUBE_FACES) {
            const faceGrid = document.createElement("div");
            faceGrid.className = `cube-face face-${face.toLowerCase()}`;
            const faceOwner = cubeState.claimedFaces[face] as "player1" | "player2" | "draw" | null;
            if (faceOwner !== null) {
                faceGrid.classList.add("claimed-face", `claimed-${faceOwner}`);

                const claimBadge = document.createElement("div");
                claimBadge.className = "face-claim-badge";
                claimBadge.textContent = faceOwner === "draw" ? "Draw" : `${getPlayerLabel(faceOwner)} claimed`;
                faceGrid.appendChild(claimBadge);
            }

            const faceBoard = getFaceBoard(cubeState, face);
            for (let i = 0; i < 9; i += 1) {
                const cell = document.createElement("button");
                cell.className = "cell cube-cell";

                const mark = faceBoard[i];
                if (mark !== null) {
                    cell.textContent = mark;
                    cell.classList.add(mark.toLowerCase());
                }

                if (recentCubeCellKeys.has(cubeCellKey(face, i))) {
                    cell.classList.add("recent");
                }

                if (mark !== null || !canPlay || Boolean(faceOwner)) {
                    cell.disabled = true;
                }
                cell.dataset.face = face;
                cell.dataset.cellIndex = String(i);
                cellElements.set(cubeCellKey(face, i), cell);
                faceGrid.appendChild(cell);
            }

            cube.appendChild(faceGrid);
        }

        let pointerDown = false;
        let dragging = false;
        let capturedPointerId: number | null = null;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragOriginRotationX = 0;
        let dragOriginRotationY = 0;
        let pendingDragRotationX = cubeRotationX;
        let pendingDragRotationY = cubeRotationY;
        let dragFrameRequestId = 0;
        const dragThresholdPx = 6;
        let hoverKey: string | null = null;

        const flushDragRotation = (): void => {
            cubeRotationX = pendingDragRotationX;
            cubeRotationY = pendingDragRotationY;
            applyCubeRotation(cube, false);
        };

        const scheduleDragRotation = (): void => {
            if (dragFrameRequestId !== 0) {
                return;
            }
            dragFrameRequestId = window.requestAnimationFrame(() => {
                dragFrameRequestId = 0;
                flushDragRotation();
            });
        };

        const syncSceneCursor = (): void => {
            scene.classList.toggle("is-dragging", dragging);
            scene.classList.toggle("is-clickable", !dragging && hoverKey !== null && canPlay);
        };

        const clearHover = (): void => {
            if (!hoverKey) {
                syncSceneCursor();
                return;
            }
            const existing = cellElements.get(hoverKey);
            if (existing) {
                existing.classList.remove("ray-hover");
            }
            hoverKey = null;
            syncSceneCursor();
        };

        const applyHover = (hit: CubeHit | null): void => {
            clearHover();
            if (!hit) {
                return;
            }
            const key = cubeCellKey(hit.face, hit.cellIndex);
            const cell = cellElements.get(key);
            if (!cell || cell.disabled) {
                syncSceneCursor();
                return;
            }
            hoverKey = key;
            cell.classList.add("ray-hover");
            syncSceneCursor();
        };

        const hitIsPlayable = (hit: CubeHit | null): hit is CubeHit => {
            if (!hit || !canPlay) {
                return false;
            }
            if (cubeState.claimedFaces[hit.face]) {
                return false;
            }
            const faceBoard = getFaceBoard(cubeState, hit.face);
            return faceBoard[hit.cellIndex] === null;
        };

        scene.addEventListener("pointerdown", (event) => {
            pointerDown = true;
            dragging = false;
            dragStartX = event.clientX;
            dragStartY = event.clientY;
            dragOriginRotationX = cubeRotationX;
            dragOriginRotationY = cubeRotationY;
            // Prevent transition lag on the first drag movement
            cube.style.transition = "none";
            applyHover(raycastCubeCell(scene, event.clientX, event.clientY));
        });

        scene.addEventListener("pointermove", (event) => {
            if (pointerDown) {
                const dx = event.clientX - dragStartX;
                const dy = event.clientY - dragStartY;

                if (!dragging && Math.hypot(dx, dy) < dragThresholdPx) {
                    return;
                }

                if (!dragging) {
                    dragging = true;
                    cube.classList.add("dragging");
                    capturedPointerId = event.pointerId;
                    scene.setPointerCapture(event.pointerId);
                    syncSceneCursor();
                }

                pendingDragRotationY = dragOriginRotationY + dx * 0.45;
                pendingDragRotationX = clamp(dragOriginRotationX - dy * 0.45, -120, 120);
                scheduleDragRotation();
                clearHover();
                return;
            }

            if (!canPlay) {
                clearHover();
                return;
            }

            applyHover(raycastCubeCell(scene, event.clientX, event.clientY));
        });

        const stopDragging = (): void => {
            if (!pointerDown) {
                return;
            }
            pointerDown = false;

            if (!dragging) {
                return;
            }

            if (dragFrameRequestId !== 0) {
                window.cancelAnimationFrame(dragFrameRequestId);
                dragFrameRequestId = 0;
                flushDragRotation();
            }

            dragging = false;
            cube.classList.remove("dragging");
            if (capturedPointerId !== null && scene.hasPointerCapture(capturedPointerId)) {
                scene.releasePointerCapture(capturedPointerId);
            }
            capturedPointerId = null;
            activeCubeFace = nearestFaceForRotation(cubeRotationX, cubeRotationY);
            syncSceneCursor();
        };


        scene.addEventListener("pointerleave", clearHover);
        scene.addEventListener("pointerup", (event) => {
            const wasDragging = dragging;
            stopDragging();

            if (wasDragging) {
                clearHover();
                return;
            }

            const hit = raycastCubeCell(scene, event.clientX, event.clientY);
            if (!hitIsPlayable(hit)) {
                clearHover();
                return;
            }

            pendingCubeMoveFace = hit.face;
            send({ type: "move", face: hit.face, cellIndex: hit.cellIndex });
            clearHover();
        });

        scene.addEventListener("pointercancel", stopDragging);

        syncSceneCursor();

        scene.appendChild(cube);
        app.appendChild(scene);

        if (isCubeRulesOpen) {
            const overlay = document.createElement("div");
            overlay.className = "rules-overlay";

            const panel = document.createElement("div");
            panel.className = "rules-panel";

            const title = document.createElement("h3");
            title.textContent = "How Cube Mode Works";

            const text = document.createElement("p");
            text.textContent = "Take turns placing your mark. First player to claim 4 faces wins.";

            const list = document.createElement("ul");
            list.innerHTML = `
                <li>Corner move marks 3 connected cells.</li>
                <li>Edge move marks 2 connected cells.</li>
                <li>Center move marks the center and its opposite center.</li>
                <li>Get 3 in a row on a face to claim it.</li>
                <li>Claimed faces are locked for the rest of the game.</li>
                <li>If a face fills with no line, it is marked a draw and is inactive.</li>
                <li>X always moves first, but X cannot start on a corner.</li>
                <li>One move can claim multiple faces.</li>
            `;

            const closeButton = document.createElement("button");
            closeButton.className = "rules-close-btn";
            closeButton.textContent = "Got it";
            closeButton.addEventListener("click", () => {
                isCubeRulesOpen = false;
                renderGame(state);
            });

            panel.addEventListener("click", (event) => event.stopPropagation());
            overlay.addEventListener("click", () => {
                isCubeRulesOpen = false;
                renderGame(state);
            });

            panel.appendChild(title);
            panel.appendChild(text);
            panel.appendChild(list);
            panel.appendChild(closeButton);
            overlay.appendChild(panel);
            app.appendChild(overlay);
        }
    }
}

// === Landing screen ===

function renderLanding(): void {
    const app = document.getElementById("app")!;
    app.innerHTML = "";
    const headerControls = document.getElementById("header-controls");
    if (headerControls) headerControls.innerHTML = "";

    const siteTitle = document.getElementById("site-title");
    if (siteTitle) {
        siteTitle.textContent = "Rubik Tac Toe";
    }

    const modeToggle = document.createElement("div");
    modeToggle.className = "mode-toggle";

    const classicBtn = document.createElement("button");
    classicBtn.className = `mode-option${selectedLandingMode === "classic" ? " active" : ""}`;
    classicBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor"><path d="M320-160v-160H160v-80h160v-160H160v-80h160v-160h80v160h160v-160h80v160h160v80H640v160h160v80H640v160h-80v-160H400v160h-80Zm80-240h160v-160H400v160Z"/></svg><span>Classic</span>`;
    classicBtn.addEventListener("click", () => {
        selectedLandingMode = "classic";
        renderLanding();
    });

    const cubeBtn = document.createElement("button");
    cubeBtn.className = `mode-option${selectedLandingMode === "cube" ? " active" : ""}`;
    cubeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor"><path d="M440-183v-274L200-596v274l240 139Zm80 0 240-139v-274L520-457v274Zm-40-343 237-137-237-137-237 137 237 137ZM160-252q-19-11-29.5-29T120-321v-318q0-22 10.5-40t29.5-29l280-161q19-11 40-11t40 11l280 161q19 11 29.5 29t10.5 40v318q0 22-10.5 40T800-252L520-91q-19 11-40 11t-40-11L160-252Zm320-228Z"/></svg><span>Cube</span>`;
    cubeBtn.addEventListener("click", () => {
        selectedLandingMode = "cube";
        renderLanding();
    });

    modeToggle.appendChild(cubeBtn);
    modeToggle.appendChild(classicBtn);
    app.appendChild(modeToggle);

    if (landingNotice) {
        const notice = document.createElement("p");
        notice.id = "status";
        notice.textContent = landingNotice;
        app.appendChild(notice);
    }

    const newBtn = document.createElement("button");
    newBtn.id = "new-room";
    newBtn.textContent = "New Room";
    newBtn.addEventListener("click", () => connectToRoom(generateRoomId(), selectedLandingMode));
    app.appendChild(newBtn);

    const divider = document.createElement("p");
    divider.className = "divider";
    divider.textContent = "or join existing";
    app.appendChild(divider);

    const joinRow = document.createElement("div");
    joinRow.id = "join-row";

    const input = document.createElement("input");
    input.id = "room-code-input";
    input.type = "text";
    input.placeholder = "Room code";
    input.maxLength = 6;
    input.spellcheck = false;

    const joinBtn = document.createElement("button");
    joinBtn.id = "join-btn";
    joinBtn.textContent = "Join";

    joinBtn.addEventListener("click", () => {
        const code = input.value.trim().toLowerCase();
        if (!isValidRoomId(code)) {
            input.setCustomValidity("6 lowercase letters or digits");
            input.reportValidity();
            return;
        }
        input.setCustomValidity("");
        connectToRoom(code);
    });

    input.addEventListener("input", () => input.setCustomValidity(""));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") joinBtn.click();
    });

    joinRow.appendChild(input);
    joinRow.appendChild(joinBtn);
    app.appendChild(joinRow);
}

// === Boot ===

window.addEventListener("popstate", () => {
    const roomId = window.location.pathname.slice(1);
    if (isValidRoomId(roomId)) {
        connectToRoom(roomId);
    } else {
        returnToLanding(null, true);
    }
});

document.getElementById("site-home-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    returnToLanding(null);
});

const pathRoomId = window.location.pathname.slice(1);
if (isValidRoomId(pathRoomId)) {
    connectToRoom(pathRoomId);
} else {
    renderLanding();
}

setInterval(() => {
    if (currentRoomId && presence.reconnectingRole && presence.reconnectDeadlineMs !== null) {
        renderGame(state);
    }
}, 250);
