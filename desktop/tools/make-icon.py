# 生成桌面端安装包图标（从成品图集里的玩家精灵裁切，深色漆木底 + 哑金描边，呼应游戏 HUD）。
# 依赖 Pillow；图标入库（desktop/build/icon.png / .ico），重新生成：npm run icon（在 desktop 目录）。

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "assets", "atlas", "pilot@2x.png")
OUT = os.path.join(ROOT, "desktop", "build")

# ACT_PLAYER_IDLE_s_00：x=0 y=1152 w=128 h=128（pilot@2x.json）；crop 为 (左, 上, 右, 下)
frame = Image.open(SRC).convert("RGBA").crop((0, 1152, 128, 1152 + 128)).resize((192, 192), Image.LANCZOS)

N = 256
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((4, 4, N - 4, N - 4), radius=52, fill=(26, 21, 15, 255), outline=(198, 154, 60, 255), width=6)
d.rounded_rectangle((14, 14, N - 14, N - 14), radius=44, outline=(126, 102, 56, 255), width=2)
img.paste(frame, ((N - 192) // 2, (N - 192) // 2), frame)

os.makedirs(OUT, exist_ok=True)
img.save(os.path.join(OUT, "icon.png"))
img.save(os.path.join(OUT, "icon.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icon written:", OUT)
