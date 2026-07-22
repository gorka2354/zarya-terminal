-- Zarya app icon — 32x32 pixel rocket over a dawn sky.
local N=32
local spr = Sprite(N,N, ColorMode.RGB)
local img = spr.cels[1].image
local function px(x,y,r,g,b,a)
  if x<0 or y<0 or x>=N or y>=N then return end
  img:drawPixel(x,y, app.pixelColor.rgba(r,g,b,a or 255))
end
local function p(x,y,c,a) px(x,y,c[1],c[2],c[3],a) end
local function hr(x0,x1,y,c,a) for x=x0,x1 do p(x,y,c,a) end end
-- palette
local BODY_L={246,241,226}; local BODY_M={221,214,194}; local BODY_S={168,159,136}
local RED={226,35,26}; local REDK={168,24,16}
local CY={120,226,226}; local CYK={47,150,150}
local FW={255,242,192}; local OR={240,102,46}; local GOLD={224,177,90}
local STAR={240,236,216}; local NOZ={110,104,90}

-- background: vertical space gradient + dawn glow + vignette
for y=0,N-1 do for x=0,N-1 do
  local t=y/(N-1)
  local r=11+(22-11)*t; local g=15+(30-15)*t; local b=26+(54-26)*t
  local dx=(x-16)/16; local dy=(y-30)/12
  local glow=math.max(0, 1-math.sqrt(dx*dx+dy*dy))
  r=r+glow*(240-r)*0.55; g=g+glow*(120-g)*0.55; b=b+glow*(60-b)*0.35
  local cx=(x-15.5)/17; local cy=(y-15.5)/17
  local vg=math.min(1, cx*cx+cy*cy)
  r=r*(1-vg*0.5); g=g*(1-vg*0.5); b=b*(1-vg*0.5)
  px(x,y, math.floor(r),math.floor(g),math.floor(b),255)
end end

-- stars + sparkle
for _,s in ipairs({{5,6,GOLD},{26,10,STAR},{7,25,STAR},{4,14,STAR}}) do p(s[1],s[2],s[3],220) end
p(25,6,FW); p(24,6,GOLD,200); p(26,6,GOLD,200); p(25,5,GOLD,200); p(25,7,GOLD,200)

-- nose cone
hr(15,16,4,RED)
hr(14,17,5,RED); p(17,5,REDK)
hr(13,18,6,RED); p(17,6,REDK); p(18,6,REDK)
hr(12,19,7,RED); p(18,7,REDK); p(19,7,REDK)
hr(12,19,8,RED); p(18,8,REDK); p(19,8,REDK)

-- body tube 9..20
for y=9,20 do for x=12,19 do
  local c = (x<=13) and BODY_L or (x<=16 and BODY_M or BODY_S)
  p(x,y,c)
end end
px(12,9,0,0,0,0); px(19,9,0,0,0,0)  -- round top

-- red band
hr(12,19,15,RED); p(18,15,REDK); p(19,15,REDK)

-- window
for yy=11,13 do for xx=14,17 do p(xx,yy, (xx>=16) and CYK or CY) end end
p(14,11,FW); p(17,13,CYK)

-- fins
for i=0,4 do
  local y=18+i
  local lx=11-i; for x=lx,11 do p(x,y,RED) end; p(lx,y,REDK)
  local rx=20+i; for x=20,rx do p(x,y,RED) end; p(rx,y,REDK)
end

-- nozzle
hr(13,18,21,BODY_S); hr(14,17,22,NOZ)

-- flame
hr(14,17,23,FW); p(13,23,GOLD); p(18,23,GOLD)
hr(13,18,24,GOLD); hr(14,17,24,FW)
hr(14,17,25,OR); p(13,25,GOLD); p(18,25,GOLD)
hr(14,17,26,OR)
p(14,27,GOLD); p(15,27,OR); p(16,27,RED); p(17,27,GOLD)
p(15,28,RED); p(16,28,RED)
p(15,29,GOLD)

-- rounded tile corners
local R=5
for _,cc in ipairs({{0,0,1,1},{N-1,0,-1,1},{0,N-1,1,-1},{N-1,N-1,-1,-1}}) do
  for dy=0,R-1 do for dx=0,R-1 do
    if (R-1-dx)^2+(R-1-dy)^2 > R*R then px(cc[1]+cc[3]*dx, cc[2]+cc[4]*dy, 0,0,0,0) end
  end end
end

spr:flatten()
spr:saveAs(app.params["dir"].."/icon-32.png")
for _,sz in ipairs({16,48,64,128,256,512}) do
  local dup = Sprite(spr)
  app.command.SpriteSize{ ui=false, width=sz, height=sz, method="nearest" }
  app.activeSprite:saveAs(app.params["dir"].."/icon-"..sz..".png")
  app.activeSprite:close()
end
