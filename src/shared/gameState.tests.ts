import { applyMove, availableMoves, createInitialState, getCurrentPlayer, type GameState } from "./gameState";

function assert(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function playMoves(state: GameState, moves: number[]): GameState {
    let current = state;

    for (const move of moves) {
        const result = applyMove(current, move);
        assert(result.ok, `Expected move ${move} to be valid`);
        current = result.state;
    }

    return current;
}

function testInitialState(): void {
    const state = createInitialState();
    assert(state.board.length === 9, "Board should have 9 cells");
    assert(getCurrentPlayer(state) === "X", "X should start");
    assert(state.status === "in_progress", "Game should start in progress");
    assert(availableMoves(state).length === 9, "All moves should be available at start");
}

function testWinScenario(): void {
    const finalState = playMoves(createInitialState(), [0, 3, 1, 4, 2]);
    assert(finalState.status === "won", "Game should be won");
    assert(finalState.winner === "X", "X should win");
    assert(finalState.winningLine?.join(",") === "0,1,2", "Winning line should be top row");
}

function testDrawScenario(): void {
    const finalState = playMoves(createInitialState(), [0, 1, 2, 4, 3, 5, 7, 6, 8]);
    assert(finalState.status === "draw", "Game should end in draw");
    assert(finalState.winner === null, "Draw should have no winner");
}

function testInvalidMoves(): void {
    const start = createInitialState();

    const firstMove = applyMove(start, 0);
    assert(firstMove.ok, "First move should be valid");

    const occupied = applyMove(firstMove.state, 0);
    assert(!occupied.ok && occupied.error === "CELL_OCCUPIED", "Cannot play occupied cell");

    const outOfBounds = applyMove(firstMove.state, 9);
    assert(!outOfBounds.ok && outOfBounds.error === "OUT_OF_BOUNDS", "Move must be within board bounds");

    const outOfTurn = applyMove(firstMove.state, 1, "X");
    assert(!outOfTurn.ok && outOfTurn.error === "NOT_YOUR_TURN", "Wrong player cannot move");

    const wonGame = playMoves(createInitialState(), [0, 3, 1, 4, 2]);
    const afterGameOver = applyMove(wonGame, 5);
    assert(!afterGameOver.ok && afterGameOver.error === "GAME_OVER", "No moves allowed after game ends");
}

function run(): void {
    testInitialState();
    testWinScenario();
    testDrawScenario();
    testInvalidMoves();

    console.log("All game-state tests passed.");
}

run();
