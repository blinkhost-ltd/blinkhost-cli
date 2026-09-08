// Presentation only. Never feed annotated text back into source or approvals.
export function terminalText(value) {
    return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => char === '\n' || char === '\t' ? char
        : `[U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);
}
// Escape already serialized JSON, including object keys. JSON.parse preserves
// the exact original values; supplementary controls require two UTF-16 escapes.
// JSON.stringify already escapes C0 controls within strings.
export function terminalJson(serialized) {
    return serialized.replace(/[\p{Cf}\p{Zl}\p{Zp}\u007f-\u009f]/gu, char => char.split('').map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
}
//# sourceMappingURL=terminal.js.map