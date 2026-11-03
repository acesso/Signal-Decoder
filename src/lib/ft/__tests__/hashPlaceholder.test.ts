import { standardHashPlaceholders } from '../hashPlaceholder'
import { parseFTMsg } from '../parser'

test("ft8mon's sized placeholders read as the standard <...>", () => {
  expect(standardHashPlaceholders('<...22> R2SL KO94')).toBe('<...> R2SL KO94')
  expect(standardHashPlaceholders('K1ABC <...12> RR73')).toBe('K1ABC <...> RR73')
  expect(standardHashPlaceholders('K1ABC RR73; W9XYZ <...22> -08')).toBe('K1ABC RR73; W9XYZ <...> -08')
  expect(standardHashPlaceholders('<KH1/KH7Z> K1ABC -10')).toBe('<KH1/KH7Z> K1ABC -10') // resolved: untouched
  // and the message is then read with its known side, as for ft8_lib's "<...>"
  expect(parseFTMsg(standardHashPlaceholders('<...22> R2SL KO94'))).toEqual(expect.objectContaining({ caller: 'R2SL', grid: 'KO94', clean: true }))
})

test("ft8mon's padded call fields: one space between words", () => {
  expect(standardHashPlaceholders(' W4PSK PU7FTW HI22')).toBe('W4PSK PU7FTW HI22')
  expect(standardHashPlaceholders(' K1AB  W4PSK -12 ')).toBe('K1AB W4PSK -12')
})
