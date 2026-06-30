import { render } from 'preact'
import '@picocss/pico/css/pico.classless.min.css'
import './popup.css'
import { App } from './App'
render(<App />, document.getElementById('app')!)
