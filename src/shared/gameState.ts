export type Mark = "X" | "O";
export type Cell = Mark | null;
export type Board = Cell[];

export type GameStatus = "in_progress" | "won" | "draw";

export type MoveError = "OUT_OF_BOUNDS" | "CELL_OCCUPIED" | "GAME_OVER" | "NOT_YOUR_TURN";

export interface GameState {
    board: Board;
    currentPlayer: Mark;
    status: GameStatus;
    winner: Mark | null;
    winningLine: number[] | null;
    moveCount: number;
}

export type MoveResult =
    | { ok: true; state: GameState }
    | { ok: false; state: GameState; error: MoveError };

const BOARD_SIZE = 9;
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

export function createInitialState(): GameState {
    return {
        board: Array<Cell>(BOARD_SIZE).fill(null),
        currentPlayer: "X",
        status: "in_progress",
        winner: null,
        winningLine: null,
        moveCount: 0,
    };
}

export function getCurrentPlayer(state: GameState): Mark {
    return state.currentPlayer;
}

export function availableMoves(state: GameState): number[] {
    const moves: number[] = [];

    for (let i = 0; i < state.board.length; i += 1) {
        if (state.board[i] === null) {
            moves.push(i);
        }
    }

    return moves;
}

export function checkWinner(board: Board): { winner: Mark; line: number[] } | null {
    for (const [a, b, c] of WINNING_LINES) {
        const value = board[a];
        if (value !== null && value === board[b] && value === board[c]) {
            return { winner: value, line: [a, b, c] };
        }
    }

    return null;
}

export function checkStatus(board: Board): Pick<GameState, "status" | "winner" | "winningLine"> {
    const winnerResult = checkWinner(board);
    if (winnerResult) {
        return {
            status: "won",
            winner: winnerResult.winner,
            winningLine: winnerResult.line,
        };
    }

    const isDraw = board.every((cell) => cell !== null);
    if (isDraw) {
        return {
            status: "draw",
            winner: null,
            winningLine: null,
        };
    }

    return {
        status: "in_progress",
        winner: null,
        winningLine: null,
    };
}

export function applyMove(state: GameState, cellIndex: number, player: Mark = state.currentPlayer): MoveResult {
    if (state.status !== "in_progress") {
        return { ok: false, state, error: "GAME_OVER" };
    }

    if (player !== state.currentPlayer) {
        return { ok: false, state, error: "NOT_YOUR_TURN" };
    }

    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= BOARD_SIZE) {
        return { ok: false, state, error: "OUT_OF_BOUNDS" };
    }

    if (state.board[cellIndex] !== null) {
        return { ok: false, state, error: "CELL_OCCUPIED" };
    }

    const nextBoard = [...state.board];
    nextBoard[cellIndex] = player;

    const nextStatus = checkStatus(nextBoard);
    const nextState: GameState = {
        board: nextBoard,
        currentPlayer: player === "X" ? "O" : "X",
        status: nextStatus.status,
        winner: nextStatus.winner,
        winningLine: nextStatus.winningLine,
        moveCount: state.moveCount + 1,
    };

    return { ok: true, state: nextState };
}
