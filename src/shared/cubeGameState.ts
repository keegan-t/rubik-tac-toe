export type CubeMark = "X" | "O";
export type CubeCell = CubeMark | null;
export type CubePlayerId = "player1" | "player2";
export type CubeFaceOwner = CubePlayerId | "draw";

export type CubeFace = "U" | "R" | "F" | "D" | "L" | "B";
export type CubeGameStatus = "in_progress" | "won";

export type CubeMoveError =
    | "OUT_OF_BOUNDS"
    | "CELL_OCCUPIED"
    | "GAME_OVER"
    | "NOT_YOUR_TURN"
    | "OPENING_CORNER_FORBIDDEN"
    | "FACE_CLAIMED";

export type CubeCornerId = "URF" | "UFL" | "ULB" | "UBR" | "DFR" | "DLF" | "DBL" | "DRB";
export type CubeEdgeId =
    | "UR"
    | "UF"
    | "UL"
    | "UB"
    | "FR"
    | "FL"
    | "BL"
    | "BR"
    | "DR"
    | "DF"
    | "DL"
    | "DB";
export type CubeCenterPairId = "UD" | "RL" | "FB";

export type ClaimUnitId = CubeCornerId | CubeEdgeId | CubeCenterPairId;
export type CubeFaceBoardSnapshot = [CubeCell, CubeCell, CubeCell, CubeCell, CubeCell, CubeCell, CubeCell, CubeCell, CubeCell];

export interface CubeGameState {
    claims: Record<ClaimUnitId, CubeCell>;
    claimedFaces: Record<CubeFace, CubeFaceOwner | null>;
    claimedFaceBoards: Record<CubeFace, CubeFaceBoardSnapshot | null>;
    faceClaimCounts: Record<CubePlayerId, number>;
    currentPlayer: CubeMark;
    status: CubeGameStatus;
    winner: CubePlayerId | null;
    lastMoveFace: CubeFace | null;
    lastMoveCellIndex: number | null;
    moveCount: number;
}

export interface CubeMove {
    face: CubeFace;
    cellIndex: number;
}

export type CubeMoveResult =
    | { ok: true; state: CubeGameState }
    | { ok: false; state: CubeGameState; error: CubeMoveError };

const FACES: ReadonlyArray<CubeFace> = ["U", "R", "F", "D", "L", "B"];
const FACE_CELL_COUNT = 9;

const CORNER_IDS: ReadonlyArray<CubeCornerId> = ["URF", "UFL", "ULB", "UBR", "DFR", "DLF", "DBL", "DRB"];
const EDGE_IDS: ReadonlyArray<CubeEdgeId> = ["UR", "UF", "UL", "UB", "FR", "FL", "BL", "BR", "DR", "DF", "DL", "DB"];
const CENTER_PAIR_IDS: ReadonlyArray<CubeCenterPairId> = ["UD", "RL", "FB"];
const CLAIM_UNIT_IDS: ReadonlyArray<ClaimUnitId> = [...CORNER_IDS, ...EDGE_IDS, ...CENTER_PAIR_IDS];

const WINNING_LINES: ReadonlyArray<readonly [number, number, number]> = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];

type FaceCellKey = `${CubeFace}:${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;

const FACE_CELL_TO_UNIT: Record<FaceCellKey, ClaimUnitId> = {
    "U:0": "ULB",
    "U:1": "UB",
    "U:2": "UBR",
    "U:3": "UL",
    "U:4": "UD",
    "U:5": "UR",
    "U:6": "UFL",
    "U:7": "UF",
    "U:8": "URF",

    "R:0": "URF",
    "R:1": "UR",
    "R:2": "UBR",
    "R:3": "FR",
    "R:4": "RL",
    "R:5": "BR",
    "R:6": "DFR",
    "R:7": "DR",
    "R:8": "DRB",

    "F:0": "UFL",
    "F:1": "UF",
    "F:2": "URF",
    "F:3": "FL",
    "F:4": "FB",
    "F:5": "FR",
    "F:6": "DLF",
    "F:7": "DF",
    "F:8": "DFR",

    "D:0": "DLF",
    "D:1": "DF",
    "D:2": "DFR",
    "D:3": "DL",
    "D:4": "UD",
    "D:5": "DR",
    "D:6": "DBL",
    "D:7": "DB",
    "D:8": "DRB",

    "L:0": "ULB",
    "L:1": "UL",
    "L:2": "UFL",
    "L:3": "BL",
    "L:4": "RL",
    "L:5": "FL",
    "L:6": "DBL",
    "L:7": "DL",
    "L:8": "DLF",

    "B:0": "UBR",
    "B:1": "UB",
    "B:2": "ULB",
    "B:3": "BR",
    "B:4": "FB",
    "B:5": "BL",
    "B:6": "DRB",
    "B:7": "DB",
    "B:8": "DBL",
};

function createEmptyClaims(): Record<ClaimUnitId, CubeCell> {
    const entries = CLAIM_UNIT_IDS.map((id) => [id, null] as const);
    return Object.fromEntries(entries) as Record<ClaimUnitId, CubeCell>;
}

function createEmptyClaimedFaces(): Record<CubeFace, CubeFaceOwner | null> {
    return {
        U: null,
        R: null,
        F: null,
        D: null,
        L: null,
        B: null,
    };
}

function createEmptyClaimedFaceBoards(): Record<CubeFace, CubeFaceBoardSnapshot | null> {
    return {
        U: null,
        R: null,
        F: null,
        D: null,
        L: null,
        B: null,
    };
}

function buildLiveFaceBoard(state: Pick<CubeGameState, "claims">, face: CubeFace): CubeFaceBoardSnapshot {
    const board: CubeCell[] = [];

    for (let i = 0; i < FACE_CELL_COUNT; i += 1) {
        const unit = FACE_CELL_TO_UNIT[`${face}:${i as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`];
        board.push(state.claims[unit]);
    }

    return board as CubeFaceBoardSnapshot;
}

function createEmptyFaceClaimCounts(): Record<CubePlayerId, number> {
    return {
        player1: 0,
        player2: 0,
    };
}

function normalizeCellIndex(cellIndex: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | null {
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= FACE_CELL_COUNT) {
        return null;
    }

    return cellIndex as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

export function getClaimUnitForFaceCell(face: CubeFace, cellIndex: number): ClaimUnitId | null {
    const normalized = normalizeCellIndex(cellIndex);
    if (normalized === null) {
        return null;
    }

    return FACE_CELL_TO_UNIT[`${face}:${normalized}`];
}

export function createInitialCubeState(): CubeGameState {
    return {
        claims: createEmptyClaims(),
        claimedFaces: createEmptyClaimedFaces(),
        claimedFaceBoards: createEmptyClaimedFaceBoards(),
        faceClaimCounts: createEmptyFaceClaimCounts(),
        currentPlayer: "X",
        status: "in_progress",
        winner: null,
        lastMoveFace: null,
        lastMoveCellIndex: null,
        moveCount: 0,
    };
}

export function getCurrentCubePlayer(state: CubeGameState): CubeMark {
    return state.currentPlayer;
}

export function getFaceBoard(state: CubeGameState, face: CubeFace): CubeCell[] {
    if (state.claimedFaces[face] !== null && state.claimedFaceBoards[face] !== null) {
        return [...state.claimedFaceBoards[face]];
    }

    return [...buildLiveFaceBoard(state, face)];
}

export function availableCubeMoves(state: CubeGameState): CubeMove[] {
    const moves: CubeMove[] = [];

    for (const face of FACES) {
        if (state.claimedFaces[face] !== null) {
            continue;
        }

        for (let cellIndex = 0; cellIndex < FACE_CELL_COUNT; cellIndex += 1) {
            const unit = FACE_CELL_TO_UNIT[`${face}:${cellIndex as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`];
            if (state.claims[unit] === null) {
                moves.push({ face, cellIndex });
            }
        }
    }

    return moves;
}

function getWinningLineForFace(board: CubeCell[]): [number, number, number] | null {
    for (const [a, b, c] of WINNING_LINES) {
        const value = board[a];
        if (value !== null && value === board[b] && value === board[c]) {
            return [a, b, c];
        }
    }

    return null;
}

function findWinningFaces(state: CubeGameState): Array<{ face: CubeFace; line: [number, number, number] }> {
    const winners: Array<{ face: CubeFace; line: [number, number, number] }> = [];

    for (const face of FACES) {
        if (state.claimedFaces[face] !== null) {
            continue;
        }

        const board = getFaceBoard(state, face);
        const line = getWinningLineForFace(board);
        if (line) {
            winners.push({ face, line });
        }
    }

    return winners;
}

function normalizePlayer(player: CubeMark, playerId?: CubePlayerId): CubePlayerId {
    if (playerId) {
        return playerId;
    }

    return player === "X" ? "player1" : "player2";
}

export function applyCubeMove(
    state: CubeGameState,
    face: CubeFace,
    cellIndex: number,
    player: CubeMark = state.currentPlayer,
    playerId?: CubePlayerId,
): CubeMoveResult {
    if (state.status !== "in_progress") {
        return { ok: false, state, error: "GAME_OVER" };
    }

    if (player !== state.currentPlayer) {
        return { ok: false, state, error: "NOT_YOUR_TURN" };
    }

    if (state.claimedFaces[face] !== null) {
        return { ok: false, state, error: "FACE_CLAIMED" };
    }

    const claimUnit = getClaimUnitForFaceCell(face, cellIndex);
    if (claimUnit === null) {
        return { ok: false, state, error: "OUT_OF_BOUNDS" };
    }

    if (state.moveCount === 0 && player === "X" && CORNER_IDS.includes(claimUnit as CubeCornerId)) {
        return { ok: false, state, error: "OPENING_CORNER_FORBIDDEN" };
    }

    if (state.claims[claimUnit] !== null) {
        return { ok: false, state, error: "CELL_OCCUPIED" };
    }

    const nextClaims: Record<ClaimUnitId, CubeCell> = {
        ...state.claims,
        [claimUnit]: player,
    };

    const nextBaseState: CubeGameState = {
        claims: nextClaims,
        claimedFaces: state.claimedFaces,
        claimedFaceBoards: state.claimedFaceBoards,
        faceClaimCounts: state.faceClaimCounts,
        currentPlayer: player === "X" ? "O" : "X",
        status: "in_progress",
        winner: null,
        lastMoveFace: face,
        lastMoveCellIndex: cellIndex,
        moveCount: state.moveCount + 1,
    };

    const winnerPlayer = normalizePlayer(player, playerId);
    const nextClaimedFaces: Record<CubeFace, CubeFaceOwner | null> = { ...state.claimedFaces };
    const nextClaimedFaceBoards: Record<CubeFace, CubeFaceBoardSnapshot | null> = { ...state.claimedFaceBoards };
    const nextFaceClaimCounts: Record<CubePlayerId, number> = { ...state.faceClaimCounts };
    const winningFaces = findWinningFaces(nextBaseState);
    for (const { face } of winningFaces) {
        if (nextClaimedFaces[face] !== null) {
            continue;
        }
        nextClaimedFaces[face] = winnerPlayer;
        nextClaimedFaceBoards[face] = buildLiveFaceBoard(nextBaseState, face);
        nextFaceClaimCounts[winnerPlayer] += 1;
    }

    for (const faceOption of FACES) {
        if (nextClaimedFaces[faceOption] !== null) {
            continue;
        }

        const board = getFaceBoard(nextBaseState, faceOption);
        if (getWinningLineForFace(board)) {
            continue;
        }

        if (board.every((value) => value !== null)) {
            nextClaimedFaces[faceOption] = "draw";
            nextClaimedFaceBoards[faceOption] = buildLiveFaceBoard(nextBaseState, faceOption);
        }
    }

    const noRemainingFaces = FACES.every((faceOption) => nextClaimedFaces[faceOption] !== null);
    const player1WinsByScore = nextFaceClaimCounts.player1 >= 4;
    const player2WinsByScore = nextFaceClaimCounts.player2 >= 4;

    let status: CubeGameStatus = "in_progress";
    let winner: CubePlayerId | null = null;

    if (player1WinsByScore || player2WinsByScore || noRemainingFaces) {
        status = "won";
        if (nextFaceClaimCounts.player1 > nextFaceClaimCounts.player2) {
            winner = "player1";
        } else if (nextFaceClaimCounts.player2 > nextFaceClaimCounts.player1) {
            winner = "player2";
        }
    }

    return {
        ok: true,
        state: {
            ...nextBaseState,
            claimedFaces: nextClaimedFaces,
            claimedFaceBoards: nextClaimedFaceBoards,
            faceClaimCounts: nextFaceClaimCounts,
            status,
            winner,
        },
    };
}

function validateFaceCellMapping(): void {
    const counts: Partial<Record<ClaimUnitId, number>> = {};

    for (const face of FACES) {
        for (let cellIndex = 0; cellIndex < FACE_CELL_COUNT; cellIndex += 1) {
            const unit = FACE_CELL_TO_UNIT[`${face}:${cellIndex as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`];
            counts[unit] = (counts[unit] ?? 0) + 1;
        }
    }

    for (const id of CORNER_IDS) {
        if (counts[id] !== 3) {
            throw new Error(`Invalid mapping: corner ${id} must appear exactly 3 times.`);
        }
    }

    for (const id of EDGE_IDS) {
        if (counts[id] !== 2) {
            throw new Error(`Invalid mapping: edge ${id} must appear exactly 2 times.`);
        }
    }

    for (const id of CENTER_PAIR_IDS) {
        if (counts[id] !== 2) {
            throw new Error(`Invalid mapping: center-pair ${id} must appear exactly 2 times.`);
        }
    }
}

validateFaceCellMapping();
