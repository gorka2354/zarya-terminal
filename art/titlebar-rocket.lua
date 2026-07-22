-- Zarya titlebar brand mark: a tiny 12x12 colour pixel rocket (transparent bg).
-- Run via pixelforge:
--   node <pixelforge>/bin/pixelforge.mjs lua art/titlebar-rocket.lua --param out=src/renderer/src/assets --param name=logo-rocket
local pf = dofile(app.params["pflib"])
local out = app.params["out"] or "."
local name = app.params["name"] or "logo-rocket"
local spr = pf.sprite(12, 12)
local img = spr.cels[1].image
local CREAM={246,241,226}; local CREAM_S={198,191,173}
local RED={226,35,26}; local REDK={168,24,16}; local CY={120,226,226}
local GOLD={224,177,90}; local OR={240,102,46}; local FW={255,242,192}
local function p(x,y,c) pf.px(img,x,y,c[1],c[2],c[3],255) end
local function hr(x0,x1,y,c) for x=x0,x1 do p(x,y,c) end end
-- nose
hr(5,6,0,RED)
hr(4,7,1,RED); p(7,1,REDK)
hr(3,8,2,RED); p(7,2,REDK); p(8,2,REDK)
-- body
for y=3,8 do p(4,y,CREAM); p(5,y,CREAM); p(6,y,CREAM_S); p(7,y,CREAM_S) end
-- window
p(5,5,CY); p(6,5,CY); p(6,5,CY)
p(5,4,CY)
-- red band
hr(4,7,7,RED); p(7,7,REDK)
-- fins
p(2,8,RED); p(3,8,RED); p(8,8,RED); p(9,8,RED)
p(2,9,RED); p(3,9,REDK); p(8,9,RED); p(9,9,REDK)
-- nozzle + flame
hr(5,6,9,CREAM_S)
p(5,10,FW); p(6,10,FW); p(4,10,GOLD); p(7,10,GOLD)
p(5,11,OR); p(6,11,RED)
spr:saveAs(out.."/"..name.."-12.png")
for _,sz in ipairs({24,48}) do pf.saveScaled(spr, sz, sz, out.."/"..name.."-"..sz..".png") end
spr:close()
