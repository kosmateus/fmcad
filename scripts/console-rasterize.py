"""Rasterize the real terminal cell grid, including its actual attributes."""
import json
import re
import sys
from PIL import Image, ImageDraw, ImageFont

data = json.load(sys.stdin)
width, height = data["width"], data["height"]
cw, ch = 9, 19
normal = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 14)
bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 14)
base = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
        "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"]
cube = [0, 95, 135, 175, 215, 255]


def color(value, background=False):
    if isinstance(value, dict):
        return (value.get("r", 0), value.get("g", 0), value.get("b", 0))
    if value in (None, "default"):
        return "#000000" if background else "#d6e2ed"
    if isinstance(value, str):
        return "#" + value if re.fullmatch(r"[0-9a-fA-F]{6}", value) else value
    if value < 16:
        return base[value]
    if value < 232:
        value -= 16
        return (cube[value // 36], cube[(value // 6) % 6], cube[value % 6])
    level = 8 + (value - 232) * 10
    return (level, level, level)


image = Image.new("RGB", (width * cw, height * ch), "#071018")
draw = ImageDraw.Draw(image)
for y, row in enumerate(data["cells"]):
    for x, cell in enumerate(row):
        attr = cell["attr"]
        bg = color(attr.get("bgColor"), True)
        fg = color(attr.get("color"))
        if attr.get("inverse"):
            bg, fg = fg, bg
        draw.rectangle((x * cw, y * ch, (x + 1) * cw - 1, (y + 1) * ch - 1), fill=bg)
for y, row in enumerate(data["cells"]):
    for x, cell in enumerate(row):
        char, attr = cell["char"], cell["attr"]
        if char in (" ", "\x00", ""):
            continue
        fg = color(attr.get("bgColor"), True) if attr.get("inverse") else color(attr.get("color"))
        # Terminals join box/block glyphs across the whole cell, independent of font advance.
        cx, cy = x * cw + cw // 2, y * ch + ch // 2
        box = {"─": "lr", "│": "ud", "┌": "rd", "┐": "ld", "└": "ru", "┘": "lu", "├": "urd", "┤": "uld"}
        if char in box:
            endpoints = {"l": (x * cw, cy), "r": ((x + 1) * cw, cy), "u": (cx, y * ch), "d": (cx, (y + 1) * ch)}
            for direction in box[char]:
                draw.line(((cx, cy), endpoints[direction]), fill=fg)
            continue
        if char in ("╭", "╮", "╰", "╯"):
            radius = 3
            if char == "╭":
                draw.arc((cx, cy, cx + 2 * radius, cy + 2 * radius), 180, 270, fill=fg)
                draw.line(((cx + radius, cy), ((x + 1) * cw, cy)), fill=fg)
                draw.line(((cx, cy + radius), (cx, (y + 1) * ch)), fill=fg)
            elif char == "╮":
                draw.arc((cx - 2 * radius, cy, cx, cy + 2 * radius), 270, 360, fill=fg)
                draw.line(((x * cw, cy), (cx - radius, cy)), fill=fg)
                draw.line(((cx, cy + radius), (cx, (y + 1) * ch)), fill=fg)
            elif char == "╰":
                draw.arc((cx, cy - 2 * radius, cx + 2 * radius, cy), 90, 180, fill=fg)
                draw.line(((cx + radius, cy), ((x + 1) * cw, cy)), fill=fg)
                draw.line(((cx, y * ch), (cx, cy - radius)), fill=fg)
            else:
                draw.arc((cx - 2 * radius, cy - 2 * radius, cx, cy), 0, 90, fill=fg)
                draw.line(((x * cw, cy), (cx - radius, cy)), fill=fg)
                draw.line(((cx, y * ch), (cx, cy - radius)), fill=fg)
            continue
        if char == "█":
            draw.rectangle((x * cw, y * ch, (x + 1) * cw - 1, (y + 1) * ch - 1), fill=fg)
            continue
        draw.text((x * cw, y * ch + 14), char, font=bold if attr.get("bold") else normal, fill=fg, anchor="ls")
image.save(sys.argv[1])
