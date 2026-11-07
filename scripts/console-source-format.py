"""Format and tokenize a JSON stdin memory copy; never load or execute user code."""
import json
import sys

MAX_INPUT = 128 * 1024 * 1024


def source_lines(text):
    lines = [[]]
    try:
        from pygments.lexers import PythonLexer
        from pygments.token import Token

        def tone(token):
            if token in Token.Comment:
                return "muted"
            if token in Token.Keyword:
                return "syntaxKeyword"
            if token in Token.Name.Function:
                return "syntaxFunction"
            if token in Token.Name.Class:
                return "syntaxType"
            if token in Token.Name.Builtin or token in Token.Name.Decorator:
                return "syntaxBuiltin"
            if token in Token.Literal.String:
                return "success"
            if token in Token.Literal.Number:
                return "warning"
            return "text"

        tokens = ((value, tone(token)) for _, token, value in PythonLexer().get_tokens_unprocessed(text))
        for value, role in tokens:
            for index, part in enumerate(value.split("\n")):
                if index:
                    lines.append([])
                if part:
                    if lines[-1] and lines[-1][-1]["tone"] == role:
                        lines[-1][-1]["text"] += part
                    else:
                        lines[-1].append({"text": part, "tone": role})
        return lines, None
    except Exception as error:
        return [[{"text": line, "tone": "text"}] for line in text.split("\n")], "Syntax colors unavailable: " + str(error)[:500]


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("Formatter input exceeds limit")
    source = json.loads(raw)["source"]
    if not isinstance(source, str):
        raise ValueError("Source must be text")
    formatted, applied, error = source, False, None
    try:
        import black
        formatted = black.format_str(source, mode=black.Mode())
        applied = True
    except Exception as failure:
        error = "Python formatting unavailable: " + str(failure)[:500]
    lines, color_error = source_lines(formatted)
    if color_error:
        # A partial formatter result must not claim full success.
        formatted, applied = source, False
        lines = [[{"text": line, "tone": "text"}] for line in source.split("\n")]
        error = "; ".join(item for item in (error, color_error) if item)
    json.dump({"formatted": formatted, "applied": applied, "error": error, "lines": lines}, sys.stdout, ensure_ascii=True, allow_nan=False)


if __name__ == "__main__":
    main()
