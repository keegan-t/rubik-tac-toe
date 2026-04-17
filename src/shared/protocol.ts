import type { CubeFace, CubeGameState, CubeMoveError } from "./cubeGameState";
import type { GameState, Mark, MoveError } from "./gameState";

export type Role = "player1" | "player2";
export type GameMode = "classic" | "cube";
export type PlayerMarks = Record<Role, Mark>;

export type ClientMessage =
    | { type: "join"; reconnectToken?: string; mode?: GameMode }
    | { type: "move"; cellIndex: number; face?: never }
    | { type: "move"; face: CubeFace; cellIndex: number }
    | { type: "reset" }
    | { type: "rematch" };

export type ServerMessage =
    | { type: "role_assigned"; role: Role; reconnectToken: string }
    | {
          type: "presence";
          player1Connected: boolean;
          player2Connected: boolean;
          reconnectingRole: Role | null;
          reconnectDeadlineMs: number | null;
      }
    | { type: "state_sync"; mode: "classic"; state: GameState; playerMarks: PlayerMarks }
    | { type: "state_sync"; mode: "cube"; state: CubeGameState; playerMarks: PlayerMarks }
    | { type: "rematch_pending"; player1Voted: boolean; player2Voted: boolean }
    | { type: "room_closed"; reason: "RECONNECT_TIMEOUT" }
    | {
          type: "error";
          error:
              | MoveError
              | CubeMoveError
              | "ROOM_FULL"
              | "ROOM_NOT_FOUND"
              | "NOT_SEATED"
              | "INVALID_MESSAGE"
              | "INVALID_ROOM"
              | "MODE_MISMATCH";
      };
