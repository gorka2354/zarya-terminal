-- Render pixelIcons.json to a preview atlas (each glyph scaled x8, gold on dark).
local path = app.params["json"]
local f = io.open(path,"r"); local data = json.decode(f:read("a")); f:close()
local icons = data.icons
local order = {"sessions","files","workflows","history","search","sputnik","gear"}
local S = data.size            -- 16
local scale = 8
local pad = 4
local cell = S*scale + pad*2
local W = cell*#order
local H = cell
local spr = Sprite(W, H, ColorMode.RGB)
local img = spr.cels[1].image
-- dark bg
for y=0,H-1 do for x=0,W-1 do img:drawPixel(x,y, app.pixelColor.rgba(16,20,34,255)) end end
local gold = app.pixelColor.rgba(224,177,90,255)
for i,name in ipairs(order) do
  local g = icons[name]
  local ox = (i-1)*cell + pad
  for r=0,S-1 do local row=g[r+1]
    for c=0,S-1 do
      if row:sub(c+1,c+1)=="1" then
        for yy=0,scale-1 do for xx=0,scale-1 do
          img:drawPixel(ox+c*scale+xx, r*scale+pad+yy, gold)
        end end
      end
    end
  end
end
spr:saveAs(app.params["out"])
