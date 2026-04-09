
#let w = 256pt
#let h = w

#set page(
  width: w, height: h,
  margin: 0pt,
  background: none
  )

/*
#let rw = 75pt
#let rh = 20pt
#let r = rect(
  stroke: none,
  fill: rgb("#00ff00"),
  width: rw,
  height: rh,
  inset: 0pt,
  outset: 0pt
)
*/

#let rw = 80pt
#let rh = rw * 1.61803398875
#let stroke = 5pt
#let radius = 5pt

#let r1 = rect(
  stroke: stroke,
  radius: radius,
  width: rw,
  height: rh,
  fill: rgb("#94949448"),
)

#let r2 = rect(
  stroke: stroke,
  radius: radius,
  width: rw,
  height: rh,
  fill: rgb("#00ff0048"),
)

#let r2 = rotate(
  r2, 
  7deg,
  origin: left + bottom 
  )


#place(r1,
  dx: w/2 - rw,
  dy: (h - rh)/2,
)

#place(r2,
  dx: w/2 ,
  dy: (h - rh)/2,
)