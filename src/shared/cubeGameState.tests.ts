import {
    applyCubeMove,
    availableCubeMoves,
    createInitialCubeState,
    getClaimUnitForFaceCell,
    getCurrentCubePlayer,
    getFaceBoard,
    type CubeFace,
    type CubeGameState,
} from "./cubeGameState";

function assert(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function playMoves(state: CubeGameState, moves: Array<{ face: CubeFace; cellIndex: number }>): CubeGameState {
    let current = state;

    for (const move of moves) {
        const result = applyCubeMove(current, move.face, move.cellIndex);
        assert(result.ok, `Expected move ${move.face}:${move.cellIndex} to be valid`);
        current = result.state;
    }

    return current;
}

function countMarksOnAllFaces(state: CubeGameState, mark: "X" | "O"): number {
    let count = 0;
    const faces: CubeFace[] = ["U", "R", "F", "D", "L", "B"];

    for (const face of faces) {
        const board = getFaceBoard(state, face);
        for (const cell of board) {
            if (cell === mark) {
                count += 1;
            }
        }
    }

    return count;
}

function testInitialState(): void {
    const state = createInitialCubeState();
    assert(getCurrentCubePlayer(state) === "X", "X should start");
    assert(state.status === "in_progress", "Game should start in progress");
    assert(state.faceClaimCounts.player1 === 0 && state.faceClaimCounts.player2 === 0, "Initial face-claim score should be 0-0");
    assert(state.moveCount === 0, "Move count should start at 0");
    assert(state.lastMoveFace === null, "Initial state should have no lastMoveFace");
    assert(state.lastMoveCellIndex === null, "Initial state should have no lastMoveCellIndex");
    assert(availableCubeMoves(state).length === 54, "All 54 face-cell moves should be available initially");
}

function testCornerClaimsThreeCells(): void {
    const opening = applyCubeMove(createInitialCubeState(), "U", 1);
    assert(opening.ok, "Opening edge move should be valid");
    const result = applyCubeMove(opening.state, "U", 8, "O");
    assert(result.ok, "Corner move should be valid after the opening turn");
    assert(countMarksOnAllFaces(result.state, "O") === 3, "Corner claim should project to exactly 3 face cells");
    assert(result.state.lastMoveFace === "U", "Last move face should be recorded");
    assert(result.state.lastMoveCellIndex === 8, "Last move cell should be recorded");
}

function testEdgeClaimsTwoCells(): void {
    const result = applyCubeMove(createInitialCubeState(), "U", 1);
    assert(result.ok, "Edge move should be valid");
    assert(countMarksOnAllFaces(result.state, "X") === 2, "Edge claim should project to exactly 2 face cells");
}

function testCenterClaimsOppositeCenter(): void {
    const result = applyCubeMove(createInitialCubeState(), "F", 4);
    assert(result.ok, "Center move should be valid");

    const fBoard = getFaceBoard(result.state, "F");
    const bBoard = getFaceBoard(result.state, "B");
    assert(fBoard[4] === "X", "Selected center should be claimed");
    assert(bBoard[4] === "X", "Opposite center should also be claimed");
    assert(countMarksOnAllFaces(result.state, "X") === 2, "Center pair should project to exactly 2 face cells");
}

function testSharedPieceOccupancyAcrossFaces(): void {
    const opening = applyCubeMove(createInitialCubeState(), "U", 1);
    assert(opening.ok, "Initial move should be valid");

    const first = applyCubeMove(opening.state, "U", 8, "O");
    assert(first.ok, "Corner claim should be valid after the opening move");

    const second = applyCubeMove(first.state, "F", 2);
    assert(!second.ok && second.error === "CELL_OCCUPIED", "Linked face cell should be occupied by same claimed piece");
}

function testFaceClaimAdvancesRound(): void {
    const endState = playMoves(createInitialCubeState(), [
        { face: "U", cellIndex: 1 },
        { face: "D", cellIndex: 1 },
        { face: "U", cellIndex: 0 },
        { face: "D", cellIndex: 0 },
        { face: "U", cellIndex: 2 },
    ]);

    assert(endState.status === "in_progress", "Match should continue after a single face claim");
    assert(endState.claimedFaces.U === "player1", "Player 1 should claim face U");
    assert(endState.claimedFaces.B === "player1", "Linked faces claimed by the same line should also score");
    assert(endState.faceClaimCounts.player1 === 2 && endState.faceClaimCounts.player2 === 0, "Score should include all simultaneously claimed faces");
    assert(getCurrentCubePlayer(endState) === "O", "Turn should still alternate after a face claim");
    assert(endState.moveCount === 5, "Move count should continue across the full match");

    const dBoard = getFaceBoard(endState, "D");
    assert(dBoard[0] === "O" && dBoard[1] === "O", "Unclaimed-face marks should carry over between rounds");
}

function testClaimedFacesAreInactive(): void {
    const start = createInitialCubeState();
    start.claimedFaces.U = "player1";

    const result = applyCubeMove(start, "U", 1);
    assert(!result.ok && result.error === "FACE_CLAIMED", "Moves on claimed faces should be rejected");
}

function testDualFaceClaimCountsBothFaces(): void {
    const state = createInitialCubeState();
    state.claims.UFL = "X";
    state.claims.URF = "X";
    state.currentPlayer = "X";
    state.moveCount = 2;

    const result = applyCubeMove(state, "U", 7, "X", "player1");
    assert(result.ok, "Shared edge move should be valid");
    assert(result.state.claimedFaces.U === "player1", "U should be claimed by the mover");
    assert(result.state.claimedFaces.F === "player1", "F should be claimed at the same time");
    assert(result.state.faceClaimCounts.player1 === 2, "A dual-face claim should add two points");
}

function testDrawFaceBecomesInactive(): void {
    const state = createInitialCubeState();
    state.claims.ULB = "X";
    state.claims.UB = "O";
    state.claims.UBR = "X";
    state.claims.UL = "X";
    state.claims.UD = "O";
    state.claims.UR = "O";
    state.claims.UFL = "O";
    state.claims.UF = "X";
    state.currentPlayer = "X";
    state.moveCount = 8;

    const result = applyCubeMove(state, "U", 8, "X", "player1");
    assert(result.ok, "Final non-winning fill move should be valid");
    assert(result.state.claimedFaces.U === "draw", "Full face without any line should become draw/inactive");
    assert(result.state.faceClaimCounts.player1 === 0 && result.state.faceClaimCounts.player2 === 0, "Drawn faces should not change score");
}

function testClaimedFaceBoardStaysFrozenAfterLaterLinkedMove(): void {
    const claimedState = playMoves(createInitialCubeState(), [
        { face: "U", cellIndex: 1 },
        { face: "D", cellIndex: 1 },
        { face: "U", cellIndex: 0 },
        { face: "D", cellIndex: 0 },
        { face: "U", cellIndex: 2 },
    ]);

    const claimedUBoardBefore = getFaceBoard(claimedState, "U");
    const linkedMove = applyCubeMove(claimedState, "F", 3, "O", "player2");
    assert(linkedMove.ok, "Move on active linked face should still be valid after U is claimed");

    const claimedUBoardAfter = getFaceBoard(linkedMove.state, "U");
    assert(
        JSON.stringify(claimedUBoardAfter) === JSON.stringify(claimedUBoardBefore),
        "Claimed face display should remain frozen after later linked moves",
    );
}

function testInvalidMoves(): void {
    const start = createInitialCubeState();

    const openingCorner = applyCubeMove(start, "U", 0);
    assert(!openingCorner.ok && openingCorner.error === "OPENING_CORNER_FORBIDDEN", "X cannot open on a corner");

    const outOfBounds = applyCubeMove(start, "U", 9);
    assert(!outOfBounds.ok && outOfBounds.error === "OUT_OF_BOUNDS", "Move index must be within face bounds");

    const firstMove = applyCubeMove(start, "U", 1);
    assert(firstMove.ok, "First move should be valid");

    const outOfTurn = applyCubeMove(firstMove.state, "U", 1, "X");
    assert(!outOfTurn.ok && outOfTurn.error === "NOT_YOUR_TURN", "Wrong player cannot move");

    const wonState = createInitialCubeState();
    wonState.status = "won";
    wonState.winner = "player1";

    const afterGameOver = applyCubeMove(wonState, "F", 4, "X", "player1");
    assert(!afterGameOver.ok && afterGameOver.error === "GAME_OVER", "No moves allowed after game ends");
}

function testClaimLookup(): void {
    assert(getClaimUnitForFaceCell("U", 8) === "URF", "U:8 should map to URF corner");
    assert(getClaimUnitForFaceCell("F", 4) === "FB", "F:4 should map to FB center pair");
    assert(getClaimUnitForFaceCell("R", 3) === "FR", "R:3 should map to FR edge");
    assert(getClaimUnitForFaceCell("L", 9) === null, "Out-of-bounds lookup should return null");
}

function run(): void {
    testInitialState();
    testCornerClaimsThreeCells();
    testEdgeClaimsTwoCells();
    testCenterClaimsOppositeCenter();
    testSharedPieceOccupancyAcrossFaces();
    testFaceClaimAdvancesRound();
    testClaimedFacesAreInactive();
    testDualFaceClaimCountsBothFaces();
    testDrawFaceBecomesInactive();
    testClaimedFaceBoardStaysFrozenAfterLaterLinkedMove();
    testInvalidMoves();
    testClaimLookup();

    console.log("All cube game-state tests passed.");
}

run();
