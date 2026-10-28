// Study-PDF template stub (Typst). Intended for typst-wasm on Vercel — NOT the native CLI.
// TODO: fill from summary JSON via sys.inputs; embed Noto Sans Hebrew + an LTR font (fonts must be bundled for wasm).
#set document(title: "סיכום הרצאה")
#set page(paper: "a4", margin: 18mm)
#set text(lang: "he", dir: rtl, font: ("Noto Sans Hebrew", "Noto Sans"), size: 11pt)

#let summary = json.decode(sys.inputs.at("summary", default: "{\"title\":\"כותרת\",\"overview\":\"סקירה עם deep learning\",\"sections\":[],\"glossary\":[]}"))

= #summary.title
#summary.overview

#for s in summary.sections [
  == #s.heading
  #for b in s.bullets [- #b]
  #if "citation" in s [#text(fill: gray, size: 9pt)[#s.citation]]
]

== מילון מונחים
#for g in summary.glossary [
  / #text(dir: ltr)[#g.term]: #g.explanation
]
