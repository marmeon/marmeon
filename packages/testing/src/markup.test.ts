import { describe, expect, it } from 'vitest';
import { misnested } from './markup.ts';

describe('misnested(): markup the HTML parser builds another tree from', () => {
  it('finds a form or a block inside a <p>, and a form inside a form', () => {
    expect(misnested('<main><p>Resend? <form class="marmeon-link" action="/x" method="post"><button type="submit">Send</button></form></p></main>')).toBe(
      '<form> inside <p> (main > p): the browser closes the <p> first',
    );
    expect(misnested('<p><span><div>x</div></span></p>')).toBe('<div> inside <p> (p > span): the browser closes the <p> first');
    expect(misnested('<form><div><form></form></div></form>')).toBe('<form> inside <form> (form > div): the browser drops the inner one');
  });

  it('passes markup the parser keeps as written — void elements, raw text, a <p> closed before the form', () => {
    expect(misnested('<div><p>Resend?</p><form action="/x"><input name="a"><br/><button>Send</button></form></div>')).toBeUndefined();
    expect(misnested('<p>a<br>b<img src="/x.png"></p><div></div>')).toBeUndefined();
    expect(misnested('<p>text</p><script type="application/json">{"html":"<p><form>"}</script><nav><form></form></nav>')).toBeUndefined();
  });
});
