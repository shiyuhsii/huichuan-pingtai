"""Recover selectable regions from the exact red overlay in an R2 screenshot.

These are display rectangles, not independent CNN coordinates or fresh inference.
Only the left grayscale view is used: the right view repeats the same rectangles.
Incomplete, intersecting or otherwise ambiguous red components are left untouched.
"""
from __future__ import annotations


def recover_display_boxes(width: int, height: int, rgb: bytes, *, max_boxes: int = 32):
    """Return 0..1 boxes in full paired-image coordinates, without confidence.

    R2 encodes red overlay pixels as RGB (255, 32, 32), while source pixels
    in the left view are grayscale. A complete connected component must be
    exactly a one-pixel rectangular perimeter; no shape is filled or guessed.
    """
    if (type(width) is not int or type(height) is not int or not 1 <= width <= 960
            or not 1 <= height <= 540 or len(rgb) != width * height * 3
            or type(max_boxes) is not int or not 1 <= max_boxes <= 32):
        raise ValueError("截图红框提取参数不正确")
    if width % 2 or width < 4 or height < 2:
        return []
    half = width // 2
    red = set()
    for y in range(height):
        start = y * width * 3
        for x in range(half):
            at = start + x * 3
            if rgb[at:at + 3] == b"\xff\x20\x20":
                red.add((x, y))

    rectangles = []
    while red:
        start = red.pop()
        pending, component = [start], {start}
        while pending:
            x, y = pending.pop()
            for point in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if point in red:
                    red.remove(point)
                    component.add(point)
                    pending.append(point)
        xs, ys = zip(*component)
        left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
        w, h = right - left + 1, bottom - top + 1
        if w < 2 or h < 2 or len(component) != 2 * w + 2 * h - 4:
            continue
        if any(x not in (left, right) and y not in (top, bottom) for x, y in component):
            continue
        rectangles.append((left, top, w, h))

    # A disagreement is not resolved by inventing or arbitrarily dropping boxes.
    if len(rectangles) > max_boxes:
        return []
    return [{"id": f"display-{x}-{y}-{w}-{h}", "x": x / width, "y": y / height,
             "w": w / width, "h": h / height}
            for x, y, w, h in sorted(rectangles, key=lambda box: (box[1], box[0]))]
