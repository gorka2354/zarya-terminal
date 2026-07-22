-- Generate white-on-transparent MASK pngs for pixel dividers + input frames.
-- Slightly hand-drawn (notched corners, textured line) — used via CSS mask +
-- background-color so they tint with the theme.
local function make(name, rows, outdir)
  local H=#rows; local W=#rows[1]
  local spr=Sprite(W,H,ColorMode.RGB)
  local img=spr.cels[1].image
  for y=0,H-1 do local r=rows[y+1] for x=0,W-1 do
    if r:sub(x+1,x+1)=="1" then img:drawPixel(x,y,app.pixelColor.rgba(255,255,255,255))
    else img:drawPixel(x,y,app.pixelColor.rgba(0,0,0,0)) end
  end end
  spr:saveAs(outdir.."/"..name..".png")
  spr:close()
end
local outdir=app.params["out"]
-- divider line: 24x3, 2px-ish core with tiny nubs + gaps (lively)
make("pixel-line", {
  "000100000000001000000000",
  "111111111011111111110111",
  "000010000000000010000010",
}, outdir)
-- input frame: 16x16, 2px border, notched corners, transparent center (9-slice, slice=2)
make("pixel-frame", {
  "0111111111111110",
  "1111111111111111",
  "1100000000000011",
  "1100000000000011",
  "1100000000000011",
  "1100000000000011",
  "1100000000000011",
  "1100000000000011",
  "1100000000000011",
  "1100000000000011",
  "1100000000000011",
  "1100000000000011",
  "1100000000000011",
  "1100000000000011",
  "1111111111111111",
  "0111111111111110",
}, outdir)
