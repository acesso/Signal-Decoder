import { contrastLevel, dominantCanvas, elementSource, fitRect, lcdViewBoxes, lcdViewFor, lcdViewNamed, registerLcdView, selectorFor, titleFor } from '../elementSource'
import { Gfx, LCD_BODY_TOP, ON } from '../gfx'

beforeEach(() => {
  document.body.innerHTML = `
    <div id="root">
      <main>
        <section><h2>Decoded messages</h2><div class="list"><p>one</p><p>two</p></div></section>
        <section><details open><summary>Signal Analysis</summary><div class="plot"><canvas width="600" height="200"></canvas></div></details></section>
        <section><div class="bare"><span>x</span></div></section>
        <section><details open><summary>Transmit <span>Idle</span><span>Queue 2</span></summary><div class="tx"></div></details></section>
      </main>
    </div>`
})

test('selectorFor finds the same element again, from the nearest id', () => {
  for (const el of document.querySelectorAll('#root *')) {
    const sel = selectorFor(el)
    expect(sel.startsWith('#root')).toBe(true)
    expect(document.querySelector(sel)).toBe(el)
  }
  expect(selectorFor(document.querySelectorAll('p')[1])).toBe('#root > main > section:nth-of-type(1) > div > p:nth-of-type(2)')
})

test('titleFor: the box\'s own heading, a heading before it, or its tag; capitals, 15 at most', () => {
  expect(titleFor(document.querySelector('section')!)).toBe('DECODED MESSAGE')
  expect(titleFor(document.querySelector('h2')!)).toBe('DECODED MESSAGE')
  expect(titleFor(document.querySelector('.list')!)).toBe('DECODED MESSAGE') // the h2 before it
  expect(titleFor(document.querySelector('canvas')!)).toBe('SIGNAL ANALYSIS') // the summary before its box
  expect(titleFor(document.querySelector('.bare span')!)).toBe('SPAN')
  expect(titleFor(document.querySelector('.tx')!)).toBe('TRANSMIT') // not the chips in the summary
})

test('fitRect keeps the shape, centred', () => {
  expect(fitRect(84, 39)).toEqual([0, 0, 84, 39])
  expect(fitRect(840, 39)).toEqual([0, 17, 84, 4]) // very wide: a band across the middle
  expect(fitRect(100, 100)).toEqual([22, 0, 39, 39])
  expect(fitRect(600, 200)).toEqual([0, 5, 84, 28]) // (39 - 28) / 2, rounded down
})

test('dominantCanvas: the element itself when it is a canvas', () => {
  const c = document.querySelector('canvas')!
  expect(dominantCanvas(c)).toBe(c)
  expect(dominantCanvas(document.querySelector('.list')!)).toBeNull()
})

test('a marked box with a registered kind is found from anything inside it', () => {
  document.querySelector('section')!.setAttribute('data-lcd-view', 'ft-contact:LU1ABC')
  document.querySelector('.bare')!.setAttribute('data-lcd-view', 'nobody-draws-this')
  const draw = jest.fn((g: Gfx, _t: number, arg: string) => { if (arg === 'LU1ABC') g.px(5, LCD_BODY_TOP + 1, ON) })
  const kind = { title: (call: string) => call, draw, focusOnTx: true }
  const off = registerLcdView('ft-contact', kind)
  const found = lcdViewFor(document.querySelectorAll('p')[0])!
  expect(found).toMatchObject({ view: 'ft-contact:LU1ABC', arg: 'LU1ABC', el: document.querySelector('section') })
  expect(found.def).toBe(kind)
  expect(lcdViewFor(document.querySelector('.bare span')!)).toBeUndefined() // marked, but no one draws it
  expect(lcdViewBoxes().map((b) => b.view)).toEqual(['ft-contact:LU1ABC'])
  expect(lcdViewNamed('ft-contact')).toMatchObject({ arg: '' })
  off()
  expect(lcdViewFor(document.querySelectorAll('p')[0])).toBeUndefined()
})

test('a view pick draws its registered kind without the box on the page, and says so while nobody draws it', () => {
  const draw = jest.fn((g: Gfx) => g.px(5, LCD_BODY_TOP + 1, ON))
  const src = elementSource({ id: 'pick-a', title: 'A', view: 'ft-map' })
  const g = new Gfx()
  src.render(g, 3)
  const placeholder = [...g.body()].some(Boolean)
  expect(placeholder).toBe(true) // "NOT ON THE PAGE NOW"
  const off = registerLcdView('ft-map', { title: () => 'MAP', draw })
  const g2 = new Gfx()
  src.render(g2, 4)
  expect(draw).toHaveBeenCalledWith(g2, 4, '')
  expect(g2.get(5, LCD_BODY_TOP + 1)).toBe(true)
  off()
})

test('a plain picked element that is replaced is found again by its selector', () => {
  const sel = selectorFor(document.querySelector('.list')!)
  const src = elementSource({ id: 'pick-b', title: 'B', selector: sel })
  const find = jest.fn((s: string) => document.querySelector(s))
  const src2 = elementSource({ id: 'pick-c', title: 'C', selector: sel }, find)
  src2.render(new Gfx(), 0)
  const fresh = document.createElement('div')
  fresh.className = 'list'
  document.querySelector('.list')!.replaceWith(fresh)
  src2.render(new Gfx(), 1)
  expect(find).toHaveBeenCalledTimes(2) // the old one went away: looked up again
  void src
})

test('contrast moves the level by 0.07 a step, within 0.02..0.95', () => {
  expect(contrastLevel(0.45, 0)).toBe(0.45)
  expect(contrastLevel(0.45, 2)).toBeCloseTo(0.31) // darker: more pixels lit
  expect(contrastLevel(0.45, -2)).toBeCloseTo(0.59)
  expect(contrastLevel(0.15, 5)).toBe(0.02)
  expect(contrastLevel(0.45, -10)).toBe(0.95)
})
