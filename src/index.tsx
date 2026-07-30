/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'
import { initAnalytics } from '$decoder-lib/analyticsInit'

const root = document.getElementById('root')

initAnalytics()
render(() => <App />, root!)
