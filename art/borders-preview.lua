local function prev(inp, scale, outp)
  local s=app.open(inp); app.command.SpriteSize{ ui=false, width=s.width*scale, height=s.height*scale, method="nearest" }
  -- recolor white->gold, transparent->dark
  local img=app.activeSprite.cels[1].image
  for it in img:pixels() do local px=it(); local a=app.pixelColor.rgbaA(px)
    if a>0 then it(app.pixelColor.rgba(224,177,90,255)) else it(app.pixelColor.rgba(16,20,34,255)) end
  end
  app.activeSprite:saveAs(outp); app.activeSprite:close()
end
prev(app.params["line"], 10, app.params["lineout"])
prev(app.params["frame"], 10, app.params["frameout"])
