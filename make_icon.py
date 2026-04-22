"""One-off script to generate iOS home-screen icons for the weather app."""
from PIL import Image, ImageDraw


def make_icon(size: int, path: str) -> None:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background: dark slate, full bleed (iOS will round the corners)
    draw.rectangle([0, 0, size, size], fill=(20, 24, 35, 255))

    s = size / 180  # scale factor relative to 180x180 base design

    # Sun — upper right
    sun_cx, sun_cy = 118 * s, 62 * s
    sun_r = 28 * s
    sun_color = (240, 192, 80, 255)
    draw.ellipse(
        [sun_cx - sun_r, sun_cy - sun_r, sun_cx + sun_r, sun_cy + sun_r],
        fill=sun_color,
    )
    # Sun rays (8 short lines)
    import math
    ray_inner = sun_r + 8 * s
    ray_outer = sun_r + 20 * s
    ray_w = int(5 * s)
    for i in range(8):
        angle = i * (math.pi / 4)
        x1 = sun_cx + ray_inner * math.cos(angle)
        y1 = sun_cy + ray_inner * math.sin(angle)
        x2 = sun_cx + ray_outer * math.cos(angle)
        y2 = sun_cy + ray_outer * math.sin(angle)
        draw.line([x1, y1, x2, y2], fill=sun_color, width=ray_w)

    # Cloud — lower portion, overlapping the sun
    cloud_color = (170, 180, 200, 255)
    # Three puffs + a base rectangle to form a cloud shape
    cloud_puffs = [
        (60 * s, 110 * s, 32 * s),   # left puff
        (92 * s, 95 * s, 36 * s),    # top puff
        (125 * s, 110 * s, 30 * s),  # right puff
    ]
    for cx, cy, r in cloud_puffs:
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=cloud_color)
    # Flat base so the cloud has a clean bottom edge
    draw.rectangle([40 * s, 110 * s, 155 * s, 135 * s], fill=cloud_color)
    draw.ellipse([30 * s, 115 * s, 70 * s, 145 * s], fill=cloud_color)
    draw.ellipse([125 * s, 115 * s, 165 * s, 145 * s], fill=cloud_color)

    # Three rain drops under the cloud
    drop_color = (74, 144, 226, 255)
    drop_w = int(6 * s)
    for dx in (70 * s, 95 * s, 120 * s):
        draw.line([dx, 148 * s, dx - 4 * s, 162 * s], fill=drop_color, width=drop_w)

    img.save(path, "PNG")
    print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    make_icon(180, "icon-180.png")
    make_icon(192, "icon-192.png")
    make_icon(512, "icon-512.png")
    make_icon(32, "favicon-32.png")
