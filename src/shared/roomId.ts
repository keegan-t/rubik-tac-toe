const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LENGTH = 6;
const VALID_PATTERN = /^[a-z0-9]{6}$/;

export function generateRoomId(): string {
    let id = "";
    for (let i = 0; i < LENGTH; i++) {
        id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return id;
}

export function isValidRoomId(id: string): boolean {
    return VALID_PATTERN.test(id);
}
