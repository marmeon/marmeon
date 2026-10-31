import { describe, expect, it } from 'vitest';
import { PAGE_SCRIPT_ID } from '@marmeon/http/protocol';
import { misnested } from './markup.ts';
import { TestResponse } from './response.ts';

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

  it('finds an <li> inside an <li>, and a <dt> or <dd> inside one', () => {
    expect(misnested('<ul><li>a<li>b</li></li></ul>')).toBe('<li> inside <li> (ul > li): the browser closes the first <li>');
    expect(misnested('<ol><li><span>a</span><div><li>b</li></div></li></ol>')).toBe('<li> inside <li> (ol > li > div): the browser closes the first <li>');
    expect(misnested('<dl><dt>a<dd>b</dd></dt></dl>')).toBe('<dd> inside <dt> or <dd> (dl > dt): the browser closes the first one');
    expect(misnested('<dl><dd><dt>a</dt></dd></dl>')).toBe('<dt> inside <dt> or <dd> (dl > dd): the browser closes the first one');
  });

  it('finds an <a> inside an <a>, a <button> inside a <button>, an <option> inside an <option>', () => {
    expect(misnested('<a href="/x"><span><a href="/y">y</a></span></a>')).toBe('<a> inside <a> (a > span): the browser closes the first <a>');
    expect(misnested('<button><span><button>x</button></span></button>')).toBe('<button> inside <button> (button > span): the browser closes the first <button>');
    expect(misnested('<select><option>a<option>b</option></option></select>')).toBe('<option> inside <option> (select > option): the browser closes the first <option>');
  });

  it('finds table content outside a table, a <tr> right inside a <table>, a cell right inside a section', () => {
    expect(misnested('<div><tr><td>a</td></tr></div>')).toBe('<tr> outside a <table> (div): the browser drops it');
    expect(misnested('<div><td>a</td></div>')).toBe('<td> outside a <table> (div): the browser drops it');
    expect(misnested('<ul><li><caption>a</caption></li></ul>')).toBe('<caption> outside a <table> (ul > li): the browser drops it');
    expect(misnested('<table><tr><td>a</td></tr></table>')).toBe('<tr> directly inside <table> (table): the browser adds a <tbody>');
    expect(misnested('<table><tbody><td>a</td></tbody></table>')).toBe('<td> directly inside <tbody> (table > tbody): the browser adds a <tr>');
  });

  it('finds the other start tags that close a <p>, and a <col> right inside a <table>', () => {
    expect(misnested('<p><li>a</li></p>')).toBe('<li> inside <p> (p): the browser closes the <p> first');
    expect(misnested('<p><dd>a</dd></p>')).toBe('<dd> inside <p> (p): the browser closes the <p> first');
    expect(misnested('<div><p><summary>a</summary></p></div>')).toBe('<summary> inside <p> (div > p): the browser closes the <p> first');
    expect(misnested('<p><center>a</center></p>')).toBe('<center> inside <p> (p): the browser closes the <p> first');
    expect(misnested('<table><col></table>')).toBe('<col> directly inside <table> (table): the browser adds a <colgroup>');
  });

  it('passes valid nesting: lists in lists, definition lists, tables with sections, links side by side', () => {
    expect(misnested('<ul><li>a<ul><li>b</li><li>c<ol><li>d</li></ol></li></ul></li><li>e</li></ul>')).toBeUndefined();
    expect(misnested('<ul><li><nav><ul><li>a</li></ul></nav></li></ul><ul><li><section><li>x</li></section></li></ul>')).toBeUndefined();
    expect(misnested('<ul><li><div><p>a</p></div></li><li><div>b</div></li></ul>')).toBeUndefined();
    expect(misnested('<dl><dt>a</dt><dd>b</dd><dt>c</dt><dd><dl><dt>d</dt><dd>e</dd></dl></dd></dl>')).toBeUndefined();
    expect(misnested('<table><caption>a</caption><colgroup><col><col></colgroup><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody><tfoot><tr><td>c</td></tr></tfoot></table>')).toBeUndefined();
    expect(misnested('<table><tbody><tr><td><table><tbody><tr><td>x</td></tr></tbody></table></td></tr></tbody></table>')).toBeUndefined();
    expect(misnested('<a href="/x">x</a><a href="/y"><div>block in a link</div></a><button>a</button><button>b</button>')).toBeUndefined();
    expect(misnested('<a href="/x"><table><tbody><tr><td><a href="/y">y</a></td></tr></tbody></table></a>')).toBeUndefined();
    expect(misnested('<a href="/x"><svg><a href="/y"><text>y</text></a></svg></a>')).toBeUndefined();
    expect(misnested('<a href="/x"><svg><foreignObject><a href="/y">y</a></foreignObject></svg></a>')).toBeUndefined();
    expect(misnested('<template><tr><td>a</td></tr></template><template><td>b</td></template>')).toBeUndefined();
    expect(misnested('<select><option><template><option>x</option></template></option></select>')).toBeUndefined();
    expect(misnested('<p><button><div>a</div></button></p>')).toBeUndefined();
    expect(misnested('<p>a</p><table><tbody><tr><td><p>a</p><div>b</div></td></tr></tbody></table>')).toBeUndefined();
    expect(misnested('<table><colgroup><col></colgroup></table><ul><li><p>a</p></li><li>b</li></ul>')).toBeUndefined();
    expect(misnested('<form><template><form></form></template></form><ul><li><!-- <li> --></li></ul>')).toBeUndefined();
    expect(misnested('<select><optgroup><option>a</option><option>b</option></optgroup></select><div><p>a</p><p>b</p></div>')).toBeUndefined();
  });
});

describe('assertHydrates() on misnested markup', () => {
  const html = (body: string) =>
    `<html><body>${body}<script type="application/json" id="${PAGE_SCRIPT_ID}">{"component":"x/Y","props":{},"url":"/","version":""}</script></body></html>`;
  const response = async (body: string) =>
    TestResponse.from(new Response(html(body), { headers: { 'content-type': 'text/html' } }), 'GET /', undefined, undefined, async () => ({ errors: [], rerendered: html(body) }));

  it('fails for an <li> in an <li>', async () => {
    const bad = await response('<ul><li>Home<li>Guests</li></li></ul>');
    expect(() => bad.assertHydrates()).toThrow(/<li> inside <li>/);
  });

  it('passes for a list in a list item', async () => {
    (await response('<ul><li>Home<ul><li>Guests</li></ul></li></ul><table><tbody><tr><td>a</td></tr></tbody></table>')).assertHydrates();
  });
});
