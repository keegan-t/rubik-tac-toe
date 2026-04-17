import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage, Server as HttpServer } from "http";
import { randomBytes } from "crypto";
import {
    applyCubeMove,
    applyMove,
    createInitialCubeState,
    createInitialState,
    isValidRoomId,
    type ClientMessage,
    type CubeFace,
    type CubeGameState,
    type GameMode,
    type GameState,
    type PlayerMarks,
    type Role,
    type ServerMessage,
} from "../shared";

const RECONNECT_GRACE_MS = 60_000;

interface Seat {
    socket: WebSocket | null;
    reconnectToken: string | null;
    reconnectDeadlineMs: number | null;
    reconnectTimer: NodeJS.Timeout | null;
}

interface Room {
    mode: GameMode;
    state: GameState | CubeGameState;
    playerMarks: PlayerMarks;
    seats: Record<Role, Seat>;
    rematchVotes: Set<Role>;
}

interface ServerOptions {
    reconnectGraceMs?: number;
}

function send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

function broadcast(room: Room, message: ServerMessage): void {
    for (const seat of Object.values(room.seats)) {
        if (seat.socket) {
            send(seat.socket, message);
        }
    }
}

function roleForSocket(room: Room, socket: WebSocket): Role | null {
    if (room.seats.player1.socket === socket) return "player1";
    if (room.seats.player2.socket === socket) return "player2";
    return null;
}

function otherRole(role: Role): Role {
    return role === "player1" ? "player2" : "player1";
}

function createRandomPlayerMarks(): PlayerMarks {
    return Math.random() < 0.5
        ? { player1: "X", player2: "O" }
        : { player1: "O", player2: "X" };
}

function createReconnectToken(): string {
    return randomBytes(16).toString("hex");
}

function clearReconnectTimer(seat: Seat): void {
    if (seat.reconnectTimer) {
        clearTimeout(seat.reconnectTimer);
        seat.reconnectTimer = null;
    }
}

function clearRoomTimers(room: Room): void {
    clearReconnectTimer(room.seats.player1);
    clearReconnectTimer(room.seats.player2);
}

function reconnectingStatus(room: Room): { role: Role | null; deadlineMs: number | null } {
    const now = Date.now();
    for (const role of ["player1", "player2"] as const) {
        const seat = room.seats[role];
        if (seat.reconnectDeadlineMs !== null && seat.reconnectDeadlineMs > now) {
            return { role, deadlineMs: seat.reconnectDeadlineMs };
        }
    }

    return { role: null, deadlineMs: null };
}

function parseClientMessage(raw: unknown): ClientMessage | null {
    if (typeof raw !== "string") {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as {
            type?: unknown;
            cellIndex?: unknown;
            face?: unknown;
            mode?: unknown;
            reconnectToken?: unknown;
        };
        if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
            return null;
        }

        if (parsed.type === "join") {
            if (
                parsed.reconnectToken === undefined ||
                typeof parsed.reconnectToken === "string"
            ) {
                if (parsed.mode === undefined || parsed.mode === "classic" || parsed.mode === "cube") {
                    return { type: "join", reconnectToken: parsed.reconnectToken, mode: parsed.mode };
                }
            }
            return null;
        }

        if (parsed.type === "reset") {
            return { type: "reset" };
        }

        if (parsed.type === "rematch") {
            return { type: "rematch" };
        }

        if (parsed.type === "move" && Number.isInteger(parsed.cellIndex)) {
            if (parsed.face === undefined) {
                return { type: "move", cellIndex: Number(parsed.cellIndex) };
            }

            if (
                parsed.face === "U" ||
                parsed.face === "R" ||
                parsed.face === "F" ||
                parsed.face === "D" ||
                parsed.face === "L" ||
                parsed.face === "B"
            ) {
                return { type: "move", face: parsed.face, cellIndex: Number(parsed.cellIndex) };
            }
        }

        return null;
    } catch {
        return null;
    }
}

function broadcastPresence(room: Room): void {
    const reconnecting = reconnectingStatus(room);
    broadcast(room, {
        type: "presence",
        player1Connected: room.seats.player1.socket !== null,
        player2Connected: room.seats.player2.socket !== null,
        reconnectingRole: reconnecting.role,
        reconnectDeadlineMs: reconnecting.deadlineMs,
    });
}

function broadcastState(room: Room): void {
    if (room.mode === "classic") {
        broadcast(room, {
            type: "state_sync",
            mode: "classic",
            state: room.state as GameState,
            playerMarks: room.playerMarks
        });
        return;
    }

    broadcast(room, {
        type: "state_sync",
        mode: "cube",
        state: room.state as CubeGameState,
        playerMarks: room.playerMarks
    });
}

function createInitialModeState(mode: GameMode): GameState | CubeGameState {
    return mode === "classic" ? createInitialState() : createInitialCubeState();
}

function assignNewGame(room: Room): void {
    room.playerMarks = createRandomPlayerMarks();
    room.state = createInitialModeState(room.mode);
}

function createRoom(mode: GameMode = "classic"): Room {
    const room: Room = {
        mode,
        state: createInitialModeState(mode),
        playerMarks: { player1: "X", player2: "O" },
        rematchVotes: new Set<Role>(),
        seats: {
            player1: { socket: null, reconnectToken: null, reconnectDeadlineMs: null, reconnectTimer: null },
            player2: { socket: null, reconnectToken: null, reconnectDeadlineMs: null, reconnectTimer: null },
        },
    };
    assignNewGame(room);
    return room;
}

export function startServer(httpServer: HttpServer, options: ServerOptions = {}): void {
    const rooms = new Map<string, Room>();
    const reconnectGraceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;

    function tryReconnectByToken(room: Room, reconnectToken: string): Role | null {
        const now = Date.now();
        for (const role of ["player1", "player2"] as const) {
            const seat = room.seats[role];
            if (
                seat.socket === null &&
                seat.reconnectToken === reconnectToken &&
                seat.reconnectDeadlineMs !== null &&
                seat.reconnectDeadlineMs > now
            ) {
                return role;
            }
        }

        return null;
    }

    function unclaimedRole(room: Room): Role | null {
        if (room.seats.player1.socket === null && room.seats.player1.reconnectToken === null) {
            return "player1";
        }
        if (room.seats.player2.socket === null && room.seats.player2.reconnectToken === null) {
            return "player2";
        }
        return null;
    }

    function roomHasNoClaimedSeats(room: Room): boolean {
        return (
            room.seats.player1.socket === null &&
            room.seats.player2.socket === null &&
            room.seats.player1.reconnectToken === null &&
            room.seats.player2.reconnectToken === null
        );
    }

    function handleReconnectTimeout(roomId: string, missingRole: Role): void {
        const room = rooms.get(roomId);
        if (!room) {
            return;
        }

        const missingSeat = room.seats[missingRole];
        if (missingSeat.socket !== null) {
            return;
        }

        missingSeat.reconnectDeadlineMs = null;
        clearReconnectTimer(missingSeat);

        const survivingRole = otherRole(missingRole);
        const otherSeat = room.seats[survivingRole];

        if (otherSeat.socket) {
            send(otherSeat.socket, { type: "room_closed", reason: "RECONNECT_TIMEOUT" });
            const survivor = otherSeat.socket;
            otherSeat.socket = null;
            survivor.close();
        }

        clearRoomTimers(room);
        rooms.delete(roomId);
    }

    const wss = new WebSocketServer({ server: httpServer });

    wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
        const rawPath = request.url ?? "";
        const roomId = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;

        if (!isValidRoomId(roomId)) {
            send(socket, { type: "error", error: "INVALID_ROOM" });
            socket.close();
            return;
        }

        let room: Room | undefined = rooms.get(roomId);

        socket.on("message", (raw: RawData) => {
            const message = parseClientMessage(raw.toString());
            if (!message) {
                send(socket, { type: "error", error: "INVALID_MESSAGE" });
                return;
            }

            if (message.type === "join") {
                if (!room) {
                    if (!message.mode) {
                        send(socket, { type: "error", error: "ROOM_NOT_FOUND" });
                        socket.close();
                        return;
                    }
                    room = createRoom();
                    rooms.set(roomId, room);
                }

                const existingRole = roleForSocket(room, socket);
                if (existingRole) {
                    const seat = room.seats[existingRole];
                    if (!seat.reconnectToken) {
                        seat.reconnectToken = createReconnectToken();
                    }
                    send(socket, {
                        type: "role_assigned",
                        role: existingRole,
                        reconnectToken: seat.reconnectToken,
                    });
                    if (room.mode === "classic") {
                        send(socket, {
                            type: "state_sync",
                            mode: "classic",
                            state: room.state as GameState,
                            playerMarks: room.playerMarks
                        });
                    } else {
                        send(socket, {
                            type: "state_sync",
                            mode: "cube",
                            state: room.state as CubeGameState,
                            playerMarks: room.playerMarks
                        });
                    }
                    const reconnecting = reconnectingStatus(room);
                    send(socket, {
                        type: "presence",
                        player1Connected: room.seats.player1.socket !== null,
                        player2Connected: room.seats.player2.socket !== null,
                        reconnectingRole: reconnecting.role,
                        reconnectDeadlineMs: reconnecting.deadlineMs,
                    });
                    return;
                }

                if (message.reconnectToken) {
                    const reconnectRole = tryReconnectByToken(room, message.reconnectToken);
                    if (reconnectRole) {
                        const seat = room.seats[reconnectRole];
                        seat.socket = socket;
                        seat.reconnectDeadlineMs = null;
                        clearReconnectTimer(seat);

                        send(socket, {
                            type: "role_assigned",
                            role: reconnectRole,
                            reconnectToken: seat.reconnectToken!,
                        });
                        if (room.mode === "classic") {
                            send(socket, {
                                type: "state_sync",
                                mode: "classic",
                                state: room.state as GameState,
                                playerMarks: room.playerMarks
                            });
                        } else {
                            send(socket, {
                                type: "state_sync",
                                mode: "cube",
                                state: room.state as CubeGameState,
                                playerMarks: room.playerMarks
                            });
                        }
                        broadcastPresence(room);
                        return;
                    }
                }

                if (message.mode && message.mode !== room.mode) {
                    if (roomHasNoClaimedSeats(room)) {
                        room.mode = message.mode;
                        assignNewGame(room);
                    } else {
                        send(socket, { type: "error", error: "MODE_MISMATCH" });
                        return;
                    }
                }

                const assignedRole = unclaimedRole(room);

                if (!assignedRole) {
                    send(socket, { type: "error", error: "ROOM_FULL" });
                    socket.close();
                    return;
                }

                const seat = room.seats[assignedRole];
                seat.socket = socket;
                seat.reconnectToken = createReconnectToken();
                seat.reconnectDeadlineMs = null;
                clearReconnectTimer(seat);

                send(socket, {
                    type: "role_assigned",
                    role: assignedRole,
                    reconnectToken: seat.reconnectToken,
                });
                if (room.mode === "classic") {
                    send(socket, {
                        type: "state_sync",
                        mode: "classic",
                        state: room.state as GameState,
                        playerMarks: room.playerMarks
                    });
                } else {
                    send(socket, {
                        type: "state_sync",
                        mode: "cube",
                        state: room.state as CubeGameState,
                        playerMarks: room.playerMarks
                    });
                }
                broadcastPresence(room);
                return;
            }

            if (!room) {
                send(socket, { type: "error", error: "NOT_SEATED" });
                return;
            }

            const role = roleForSocket(room, socket);
            if (!role) {
                send(socket, { type: "error", error: "NOT_SEATED" });
                return;
            }

            if (message.type === "reset") {
                room.rematchVotes.clear();
                assignNewGame(room);
                broadcastState(room);
                return;
            }

            if (message.type === "rematch") {
                if (room.state.status === "in_progress") {
                    send(socket, { type: "error", error: "INVALID_MESSAGE" });
                    return;
                }

                room.rematchVotes.add(role);
                broadcast(room, {
                    type: "rematch_pending",
                    player1Voted: room.rematchVotes.has("player1"),
                    player2Voted: room.rematchVotes.has("player2"),
                });

                if (room.rematchVotes.has("player1") && room.rematchVotes.has("player2")) {
                    room.rematchVotes.clear();
                    assignNewGame(room);
                    broadcastState(room);
                }

                return;
            }

            if (message.type === "move") {
                const playerMark = room.playerMarks[role];

                if (room.mode === "classic") {
                    if ("face" in message) {
                        send(socket, { type: "error", error: "INVALID_MESSAGE" });
                        return;
                    }

                    const moveResult = applyMove(room.state as GameState, message.cellIndex, playerMark);
                    if (!moveResult.ok) {
                        send(socket, { type: "error", error: moveResult.error });
                        return;
                    }

                    room.state = moveResult.state;
                    broadcastState(room);
                    return;
                }

                if (!("face" in message)) {
                    send(socket, { type: "error", error: "INVALID_MESSAGE" });
                    return;
                }

                const previousState = room.state as CubeGameState;
                const moveResult = applyCubeMove(previousState, message.face as CubeFace, message.cellIndex, playerMark, role);
                if (!moveResult.ok) {
                    send(socket, { type: "error", error: moveResult.error });
                    return;
                }

                room.state = moveResult.state;
                broadcastState(room);
            }
        });

        socket.on("close", () => {
            if (!room) return;
            const role = roleForSocket(room, socket);
            if (!role) {
                return;
            }

            const seat = room.seats[role];
            seat.socket = null;

            // Cancel any rematch vote from the disconnecting player
            if (room.rematchVotes.delete(role)) {
                broadcast(room, {
                    type: "rematch_pending",
                    player1Voted: room.rematchVotes.has("player1"),
                    player2Voted: room.rematchVotes.has("player2"),
                });
            }

            const survivingRole = otherRole(role);
            const otherSeat = room.seats[survivingRole];
            if (otherSeat.socket === null) {
                clearRoomTimers(room);
                rooms.delete(roomId);
                return;
            }

            seat.reconnectDeadlineMs = Date.now() + reconnectGraceMs;
            clearReconnectTimer(seat);
            seat.reconnectTimer = setTimeout(() => {
                handleReconnectTimeout(roomId, role);
            }, reconnectGraceMs);

            broadcastPresence(room);
        });
    });

}
