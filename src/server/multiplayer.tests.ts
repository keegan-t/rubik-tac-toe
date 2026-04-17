import { WebSocket, type RawData } from "ws";
import { startServer } from "./index";
import { generateRoomId } from "../shared";
import type { ClientMessage, ServerMessage } from "../shared";

function assert(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

class TestClient {
    private socket: WebSocket;
    private queue: ServerMessage[] = [];
    private waiters: Array<(message: ServerMessage) => void> = [];

    constructor(url: string) {
        this.socket = new WebSocket(url);
        this.socket.on("message", (raw: RawData) => {
            const parsed = JSON.parse(raw.toString()) as ServerMessage;
            const waiter = this.waiters.shift();
            if (waiter) {
                waiter(parsed);
            } else {
                this.queue.push(parsed);
            }
        });
    }

    waitUntilOpen(): Promise<void> {
        if (this.socket.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            this.socket.once("open", () => resolve());
            this.socket.once("error", (error: Error) => reject(error));
        });
    }

    send(message: ClientMessage): void {
        this.socket.send(JSON.stringify(message));
    }

    async nextMatching(
        predicate: (message: ServerMessage) => boolean,
        timeoutMs = 1000,
    ): Promise<ServerMessage> {
        for (let i = 0; i < this.queue.length; i += 1) {
            if (predicate(this.queue[i])) {
                return this.queue.splice(i, 1)[0];
            }
        }

        return new Promise<ServerMessage>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Timed out waiting for expected server message"));
            }, timeoutMs);

            const handle = (message: ServerMessage): void => {
                if (predicate(message)) {
                    clearTimeout(timeout);
                    resolve(message);
                    return;
                }

                this.queue.push(message);
                this.waiters.push(handle);
            };

            this.waiters.push(handle);
        });
    }

    close(): Promise<void> {
        if (this.socket.readyState === WebSocket.CLOSED) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            this.socket.once("close", () => resolve());
            this.socket.close();
        });
    }

    waitUntilClose(timeoutMs = 1000): Promise<void> {
        if (this.socket.readyState === WebSocket.CLOSED) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Timed out waiting for socket close"));
            }, timeoutMs);

            this.socket.once("close", () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }
}

async function run(): Promise<void> {
    const server = startServer(0, { reconnectGraceMs: 300 });
    const url = `ws://127.0.0.1:${server.port}`;

    // Test: invalid room ID is rejected
    const badClient = new TestClient(`${url}/!!!`);
    await badClient.waitUntilOpen();
    const invalidRoom = await badClient.nextMatching((m) => m.type === "error");
    assert(
        invalidRoom.type === "error" && invalidRoom.error === "INVALID_ROOM",
        "Invalid room path should be rejected",
    );
    await badClient.close();

    // Test: two players in same room
    const roomId = generateRoomId();
    const roomUrl = `${url}/${roomId}`;

    const player1Client = new TestClient(roomUrl);
    await player1Client.waitUntilOpen();
    player1Client.send({ type: "join" });

    const player1Role = await player1Client.nextMatching((m) => m.type === "role_assigned");
    assert(player1Role.type === "role_assigned" && player1Role.role === "player1", "First client should be assigned player1");
    assert(player1Role.type === "role_assigned" && typeof player1Role.reconnectToken === "string", "player1 should get reconnect token");
    const player1Token = player1Role.type === "role_assigned" ? player1Role.reconnectToken : "";
    const player1Initial = await player1Client.nextMatching((m) => m.type === "state_sync" && m.mode === "classic");
    assert(player1Initial.type === "state_sync" && player1Initial.mode === "classic", "player1 should receive initial classic state");
    assert(
        player1Initial.type === "state_sync" &&
        player1Initial.playerMarks.player1 !== player1Initial.playerMarks.player2,
        "Players should receive opposite randomized marks",
    );

    const player2Client = new TestClient(roomUrl);
    await player2Client.waitUntilOpen();
    player2Client.send({ type: "join" });

    const player2Role = await player2Client.nextMatching((m) => m.type === "role_assigned");
    assert(player2Role.type === "role_assigned" && player2Role.role === "player2", "Second client should be assigned player2");
    assert(player2Role.type === "role_assigned" && typeof player2Role.reconnectToken === "string", "player2 should get reconnect token");
    const player2Initial = await player2Client.nextMatching((m) => m.type === "state_sync" && m.mode === "classic");
    assert(player2Initial.type === "state_sync" && player2Initial.mode === "classic", "player2 should receive initial classic state");

    const xClient = player1Initial.type === "state_sync" && player1Initial.playerMarks.player1 === "X" ? player1Client : player2Client;
    const oClient = xClient === player1Client ? player2Client : player1Client;

    // Test: third client in same room is rejected
    const thirdClient = new TestClient(roomUrl);
    await thirdClient.waitUntilOpen();
    thirdClient.send({ type: "join" });
    const roomFull = await thirdClient.nextMatching((m) => m.type === "error");
    assert(roomFull.type === "error" && roomFull.error === "ROOM_FULL", "Third client should be rejected");
    await thirdClient.close();

    // Test: room isolation
    const otherRoomId = generateRoomId();
    const isolatedClient = new TestClient(`${url}/${otherRoomId}`);
    await isolatedClient.waitUntilOpen();
    isolatedClient.send({ type: "join" });
    const isolatedRole = await isolatedClient.nextMatching((m) => m.type === "role_assigned");
    assert(
        isolatedRole.type === "role_assigned" && isolatedRole.role === "player1",
        "First player in a different room should get player1 independently",
    );
    await isolatedClient.close();

    // Test: valid move broadcast to both players
    xClient.send({ type: "move", cellIndex: 0 });
    const xState = await xClient.nextMatching((m) => m.type === "state_sync" && m.mode === "classic" && m.state.board[0] === "X");
    const oState = await oClient.nextMatching((m) => m.type === "state_sync" && m.mode === "classic" && m.state.board[0] === "X");
    assert(xState.type === "state_sync", "X should receive state after move");
    assert(oState.type === "state_sync", "O should receive same state after X's move");

    // Test: disconnect triggers reconnect grace and blocks new joins
    await player1Client.close();
    const waitingPresence = await player2Client.nextMatching(
        (m) => m.type === "presence" && m.reconnectingRole === "player1" && m.reconnectDeadlineMs !== null,
    );
    assert(waitingPresence.type === "presence", "Connected player should be told player1 is reconnecting");

    const blockedDuringGrace = new TestClient(roomUrl);
    await blockedDuringGrace.waitUntilOpen();
    blockedDuringGrace.send({ type: "join" });
    const blockedError = await blockedDuringGrace.nextMatching((m) => m.type === "error");
    assert(blockedError.type === "error" && blockedError.error === "ROOM_FULL", "Room should stay full during grace");
    await blockedDuringGrace.close();

    // Test: reconnect with token restores seat and game state
    const player1Reconnected = new TestClient(roomUrl);
    await player1Reconnected.waitUntilOpen();
    player1Reconnected.send({ type: "join", reconnectToken: player1Token });
    const player1RejoinRole = await player1Reconnected.nextMatching((m) => m.type === "role_assigned");
    assert(player1RejoinRole.type === "role_assigned" && player1RejoinRole.role === "player1", "player1 should reclaim seat with token");

    const player1RejoinState = await player1Reconnected.nextMatching((m) => m.type === "state_sync");
    assert(
        player1RejoinState.type === "state_sync" && player1RejoinState.mode === "classic" && player1RejoinState.state.board[0] === "X",
        "Reconnected player1 should receive preserved board state",
    );

    const backPresence = await player2Client.nextMatching((m) => m.type === "presence" && m.reconnectingRole === null);
    assert(backPresence.type === "presence" && backPresence.player1Connected, "player2 should see player1 return");

    const xPlayer = player1RejoinState.type === "state_sync" && player1RejoinState.playerMarks.player1 === "X" ? player1Reconnected : player2Client;
    const oPlayer = xPlayer === player1Reconnected ? player2Client : player1Reconnected;

    // Test: out-of-turn move rejected
    xPlayer.send({ type: "move", cellIndex: 1 });
    const outOfTurn = await xPlayer.nextMatching((m) => m.type === "error" && m.error === "NOT_YOUR_TURN");
    assert(outOfTurn.type === "error", "Out-of-turn move should be rejected");

    // Test: occupied cell rejected
    oPlayer.send({ type: "move", cellIndex: 0 });
    const occupied = await oPlayer.nextMatching((m) => m.type === "error" && m.error === "CELL_OCCUPIED");
    assert(occupied.type === "error", "Occupied-cell move should be rejected");

    // Test: play to win, then reject post-game move
    // Board after X:0 - continue: O:3, X:1, O:4, X:2 -> X wins top row
    oPlayer.send({ type: "move", cellIndex: 3 });
    await player1Reconnected.nextMatching((m) => m.type === "state_sync" && m.mode === "classic" && m.state.board[3] === "O");
    await player2Client.nextMatching((m) => m.type === "state_sync" && m.mode === "classic" && m.state.board[3] === "O");

    xPlayer.send({ type: "move", cellIndex: 1 });
    await player1Reconnected.nextMatching((m) => m.type === "state_sync" && m.mode === "classic" && m.state.board[1] === "X");
    await player2Client.nextMatching((m) => m.type === "state_sync" && m.mode === "classic" && m.state.board[1] === "X");

    oPlayer.send({ type: "move", cellIndex: 4 });
    await player1Reconnected.nextMatching((m) => m.type === "state_sync" && m.mode === "classic" && m.state.board[4] === "O");
    await player2Client.nextMatching((m) => m.type === "state_sync" && m.mode === "classic" && m.state.board[4] === "O");

    xPlayer.send({ type: "move", cellIndex: 2 });
    const winState = await xPlayer.nextMatching((m) => m.type === "state_sync" && m.mode === "classic" && m.state.status === "won");
    assert(winState.type === "state_sync" && winState.mode === "classic" && winState.state.winner === "X", "X should win top row");

    oPlayer.send({ type: "move", cellIndex: 5 });
    const gameOver = await oPlayer.nextMatching((m) => m.type === "error" && m.error === "GAME_OVER");
    assert(gameOver.type === "error", "Moves after game-over should be rejected");

    // Test: timeout kicks remaining player to landing path
    await player1Reconnected.close();
    const timeoutCloseNotice = await player2Client.nextMatching((m) => m.type === "room_closed");
    assert(
        timeoutCloseNotice.type === "room_closed" && timeoutCloseNotice.reason === "RECONNECT_TIMEOUT",
        "Remaining player should be notified when reconnect grace expires",
    );
    await player2Client.waitUntilClose(1000);

    // Test: cube mode room uses face+cell moves and returns cube state
    const cubeRoomId = generateRoomId();
    const cubeRoomUrl = `${url}/${cubeRoomId}`;

    const cubePlayer1 = new TestClient(cubeRoomUrl);
    await cubePlayer1.waitUntilOpen();
    cubePlayer1.send({ type: "join", mode: "cube" });
    const cubePlayer1Role = await cubePlayer1.nextMatching((m) => m.type === "role_assigned");
    assert(cubePlayer1Role.type === "role_assigned" && cubePlayer1Role.role === "player1", "First cube client should be player1");
    const cubeInitial = await cubePlayer1.nextMatching((m) => m.type === "state_sync");
    assert(cubeInitial.type === "state_sync" && cubeInitial.mode === "cube", "Cube room should sync in cube mode");

    const cubePlayer2 = new TestClient(cubeRoomUrl);
    await cubePlayer2.waitUntilOpen();
    cubePlayer2.send({ type: "join" });
    const cubePlayer2Role = await cubePlayer2.nextMatching((m) => m.type === "role_assigned");
    assert(cubePlayer2Role.type === "role_assigned" && cubePlayer2Role.role === "player2", "Second cube client should be player2");
    await cubePlayer2.nextMatching((m) => m.type === "state_sync" && m.mode === "cube");

    const cubeX = cubeInitial.type === "state_sync" && cubeInitial.playerMarks.player1 === "X" ? cubePlayer1 : cubePlayer2;
    const cubeOther = cubeX === cubePlayer1 ? cubePlayer2 : cubePlayer1;

    cubeX.send({ type: "move", face: "U", cellIndex: 1 });
    const cubeMoveSync = await cubeX.nextMatching((m) => m.type === "state_sync" && m.mode === "cube" && m.state.moveCount === 1);
    assert(cubeMoveSync.type === "state_sync" && cubeMoveSync.mode === "cube", "Cube move should advance cube state");

    cubeOther.send({ type: "move", cellIndex: 0 });
    const invalidCubeMove = await cubeOther.nextMatching((m) => m.type === "error" && m.error === "INVALID_MESSAGE");
    assert(invalidCubeMove.type === "error", "Cube mode should reject classic move payloads");

    await cubePlayer1.close();
    await cubePlayer2.close();

    await server.close();

    console.log("All multiplayer tests passed.");
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
