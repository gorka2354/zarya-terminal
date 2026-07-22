-- Zarya app icon — retro-synthwave DAWN SUN (pixel): orange→yellow→white
-- gradient with horizontal "blind" slits toward the bottom, on a dark squircle.
local pf = dofile(app.params["pflib"])
local outdir = app.params["out"] or "."
local name = app.params["name"] or "zarya"
local N = 32
local transparent = app.params["transparent"] == "1"
local spr = pf.sprite(N, N)
local img = spr.cels[1].image
if not transparent then pf.fill(img, N, N, 10, 14, 26, 255) end  -- dark bg

local cx, cy, R = 16, 15.5, 12.0
local top, bot = cy - R, cy + R
local stops = {
  { 0.00, 232, 84, 26 }, { 0.26, 255, 118, 40 }, { 0.48, 255, 172, 44 },
  { 0.68, 255, 214, 54 }, { 0.84, 255, 240, 92 }, { 1.00, 255, 248, 184 }
}
local function grad(t)
  if t < 0 then t = 0 elseif t > 1 then t = 1 end
  for i = 1, #stops - 1 do
    local a, b = stops[i], stops[i + 1]
    if t >= a[1] and t <= b[1] then
      local f = (t - a[1]) / (b[1] - a[1])
      return math.floor(a[2] + (b[2] - a[2]) * f),
             math.floor(a[3] + (b[3] - a[3]) * f),
             math.floor(a[4] + (b[4] - a[4]) * f)
    end
  end
  return stops[#stops][2], stops[#stops][3], stops[#stops][4]
end
-- horizontal slit rows (dark gaps) — thin near the middle, growing toward bottom
local gaps = { [17] = true, [21] = true, [24] = true, [26] = true }
for y = 0, N - 1 do
  for x = 0, N - 1 do
    local dx = (x - cx) / R
    local dy = (y - cy) / R
    if dx * dx + dy * dy <= 1.0 and not gaps[y] then
      local r, g, b = grad((y - top) / (bot - top))
      pf.px(img, x, y, r, g, b, 255)
    end
  end
end
if not transparent then pf.roundCorners(img, N, N, 5) end
spr:saveAs(outdir .. "/" .. name .. "-32.png")
for _, sz in ipairs({ 16, 24, 48, 64, 128, 256, 512 }) do
  pf.saveScaled(spr, sz, sz, outdir .. "/" .. name .. "-" .. sz .. ".png")
end
spr:close()
