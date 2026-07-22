local frame = {
  "0111111111111110","1111111111111111","1100000000000011","1100000000000011",
  "1100000000000011","1100000000000011","1100000000000011","1100000000000011",
  "1100000000000011","1100000000000011","1100000000000011","1100000000000011",
  "1100000000000011","1100000000000011","1111111111111111","0111111111111110"
}
local function make(name,r,g,b,a,out)
  local spr=Sprite(16,16,ColorMode.RGB); local img=spr.cels[1].image
  for y=0,15 do local row=frame[y+1] for x=0,15 do
    if row:sub(x+1,x+1)=="1" then img:drawPixel(x,y,app.pixelColor.rgba(r,g,b,a))
    else img:drawPixel(x,y,app.pixelColor.rgba(0,0,0,0)) end
  end end
  spr:saveAs(out.."/"..name..".png"); spr:close()
end
local o=app.params["out"]
make("pixel-frame-dark", 224,177,90,150, o)
make("pixel-frame-light", 40,20,12,110, o)
