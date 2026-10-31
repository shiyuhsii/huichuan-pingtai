"""Offline checks for recovery of display rectangles, never model inference."""
import unittest

from display_boxes import recover_display_boxes


def image_with_rectangles(width, height, rectangles, *, extra=()):
    rgb = bytearray(b"\x70\x70\x70" * width * height)
    def red(x, y):
        at = (y * width + x) * 3
        rgb[at:at + 3] = b"\xff\x20\x20"
    for x, y, w, h in rectangles:
        for xx in range(x, x + w):
            red(xx, y)
            red(xx, y + h - 1)
        for yy in range(y, y + h):
            red(x, yy)
            red(x + w - 1, yy)
    for point in extra:
        red(*point)
    return bytes(rgb)


class DisplayBoxTests(unittest.TestCase):
    def test_full_paired_coordinates_and_mirror_not_duplicated(self):
        rgb = image_with_rectangles(100, 60, [(10, 20, 20, 10), (60, 20, 20, 10)])
        self.assertEqual(recover_display_boxes(100, 60, rgb), [{
            "id": "display-10-20-20-10", "x": .1, "y": 20 / 60, "w": .2, "h": 10 / 60,
        }])

    def test_deterministic_order_and_ids(self):
        rgb = image_with_rectangles(100, 60, [(5, 30, 3, 4), (20, 5, 10, 10)])
        boxes = recover_display_boxes(100, 60, rgb)
        self.assertEqual(boxes, recover_display_boxes(100, 60, rgb))
        self.assertEqual([b["id"] for b in boxes], ["display-20-5-10-10", "display-5-30-3-4"])
        self.assertTrue(all(set(box) == {"id", "x", "y", "w", "h"} for box in boxes))

    def test_broken_or_intersecting_frames_are_not_guessed(self):
        rgb = bytearray(image_with_rectangles(100, 60, [(5, 5, 10, 10), (20, 20, 12, 12), (25, 25, 12, 12)]))
        at = (5 * 100 + 7) * 3
        rgb[at:at + 3] = b"\x70\x70\x70"
        self.assertEqual(recover_display_boxes(100, 60, bytes(rgb)), [])

    def test_near_red_and_grayscale_shapes_are_not_overlay(self):
        rgb = image_with_rectangles(100, 60, [(10, 10, 10, 10)]).replace(b"\xff\x20\x20", b"\xff\x21\x20")
        self.assertEqual(recover_display_boxes(100, 60, rgb), [])
        self.assertEqual(recover_display_boxes(100, 60, b"\xff\xff\xff" * 6000), [])

    def test_clipped_frame_is_not_reconstructed(self):
        rgb = image_with_rectangles(100, 60, [(45, 10, 10, 10)])
        self.assertEqual(recover_display_boxes(100, 60, rgb), [])

    def test_count_disagreement_does_not_arbitrarily_choose_a_subset(self):
        rgb = image_with_rectangles(100, 60, [(5, 5, 10, 10), (20, 20, 10, 10)])
        self.assertEqual(recover_display_boxes(100, 60, rgb, max_boxes=1), [])

    def test_boundary_frame_is_normalized_inside_image(self):
        rgb = image_with_rectangles(100, 60, [(0, 0, 50, 60)])
        self.assertEqual(recover_display_boxes(100, 60, rgb), [{
            "id": "display-0-0-50-60", "x": 0, "y": 0, "w": .5, "h": 1,
        }])


if __name__ == "__main__":
    unittest.main()
