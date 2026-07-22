-- Zarya app icon — retro-synthwave DAWN SUN, drawn NATIVELY at any size N so
-- every .ico entry is crisp (no blurry non-integer down/upscaling). Params:
--   N (canvas px, default 32), transparent (1 = no bg/corners), out, name.
local pf = dofile(app.params["pflib"])
local N = tonumber(app.params["N"]) or 32
local transparent = app.params["transparent"] == "1"
local outdir = app.params["out"] or "."
local name = app.params["name"] or "zarya"

local spr = pf.sprite(N, N)
local img = spr.cels[1].image
if not transparent then pf.fill(img, N, N, 10, 14, 26, 255) end

local cx = (N - 1) / 2
local cy = N * 0.475
local R = N * 0.375
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

-- horizontal slit gaps in the lower part; thickness + count scale with N
local gapT = math.max(1, math.floor(N / 26 + 0.5))
local fracs = N < 22 and { 0.66, 0.86 } or (N < 40 and { 0.60, 0.75, 0.88 } or { 0.58, 0.71, 0.82, 0.92 })
local gaps = {}
for _, f in ipairs(fracs) do
  local gy = math.floor(top + f * (bot - top) + 0.5)
  for k = 0, gapT - 1 do gaps[gy + k] = true end
end

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

if not transparent then pf.roundCorners(img, N, N, math.max(2, math.floor(N / 6 + 0.5))) end
spr:saveAs(outdir .. "/" .. name .. "-" .. N .. ".png")
spr:close()
