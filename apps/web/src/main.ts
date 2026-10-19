// The web app's one entry (T21, D-02): index.html loads this module and nothing else. For now it
// holds only the styles: the two self-hosted font faces (Figtree and Bricolage Grotesque, the
// upright weight axis only; R-17, OD-27) and the app's stylesheet. They are static CSS imports of
// the entry, so Vite links them in index.html's head before any script runs.
import '@fontsource-variable/figtree/index.css'
import '@fontsource-variable/bricolage-grotesque/index.css'
import './styles/app.css'
