'use strict';

// How does one host the seaoflogs library? It is designed to run in a sandboxed
// iframe which has seaoflogs.js and seaoflogs.css and an empty body, and which has
// only a small number of connection-points to the host outside that sandbox:
// (1) When the user interacts with seaoflogs to alter the drillstate, seaoflogs wants
// to store the current drillstate in the browser's url, but being in a sandbox it's
// not allowed to - hence it uses postMessage to request its host to alter the url;
// (2) When seaoflogs first starts up it must be told the initial url drillstate,
// and the target to which send updates via postMessage, and must be given any log
// content with which to populate itself initially. This is done either by having
// a same-origin host invoke its .init(params, target, logs) method, or by specifying
// the three declaratively in three tags <meta name="seaoflogs_params" content="..."/>
// and name="seaoflogs_target" and "seaoflogs_logs". The tag route is appealing
// because the sandbox doesn't even need any same-origin permissions.


// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================
// GLOBAL MUTABLE STATE
// In addition to these variables, the URL query params also provide
// one state field 'details' used by render_popup to know the details
// function.
// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================

/** a global list of all messages from all known logs, even if they're hidden (unchecked).
 * It is initially empty; it is only ever appended, upon window.onload and clicking the
 * "load" button.
 */
let global_messages = [];

/** a count of how many messages are in each named log. */
let global_log_counts = {};

/** global autocomplete dictionary, constructed by control_handler after re-rendering
 * current messages. It is a map {member_name -> {hint:string, nested:dictionary}}
 * We treat an array [1,2,3] as a dictionary with a single member {ELEMENT -> [element_types]}
 */
let global_current_dictionary = {};

/** this is a timer to debounce edits and resizes, used by control_handler
 */
let global_debounce_timeout = null;

/** resize_expected_height is the last height to have been computed for the messages div;
 * control_handler detects upon scroll that if the current height is different, then all
 * svg lines will have to be recomputed
 */
let global_resize_expected_height = null;

/** If a popup is up, this is its index (into the unfiltered/unsorted global_messages)
 */
let global_popup_message_index = null;

/** When we want to alter the url query params, we'll do it by postMessage to this
 * target. Initialized by the 'init' method.
 */
let global_target = null;

// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================
// ENTRY POINTS
// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================

window.onload = (_) => {
  const params = document.getElementsByTagName("meta")["seaoflogs_params"]?.content;
  const target = document.getElementsByTagName("meta")["seaoflogs_target"]?.content;
  const logs = document.getElementsByTagName("meta")["seaoflogs_logs"]?.content;
  if (params != null || target != null || logs != null) {
      init(new URLSearchParams(params), target, logs);
  }
}

/** This entry-point may be called either directly from a same-origin host,
 * or by the window.onload handler
 */
function init(params, target, logs_src) {
  // Chrome treats local files specially: they all have target 'null' for purposes of postMessage
  global_target = target;
  global_messages = [];
  global_log_counts = {};

  let acc = [];
  let log = "(default)";
  const lines = logs_src.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^==> (.*) <==$/);
    if (match) {
      global_messages = global_messages.concat(parse_log(log, acc));
      log = logname_from_filepath(match[1]);
      acc = [];
    } else {
      acc.push(line);
      continue;
    }
  }
  global_messages = global_messages.concat(parse_log(log, acc));
  reconcile_log_dates(global_messages);
  global_log_counts = tally_logs(global_messages);
  for (let i=0; i<global_messages.length; i++) global_messages[i].gindex=i;

  render_page();
  render_controls();
  document.getElementById(
      "loading"
  ).innerText = `Loading ${global_messages.length} messages...`;
  write_controls(params);
  control_handler({type: 'init'});

  // If resizes causes messages to wrap, we'll need to re-render them:
  window.onresize = (event) => control_handler(event);
  // If user presses Escape, hide all active pops:
  document.onkeydown = (event) => hide_popups_handler(event);
  // We synthesize background colors lazily with this function:
  document.addEventListener("scroll", () => render_missing_backgrounds());
}

// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================
// EVENT HANDLERS
// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================


/** Called by a click on the Load button. Job is to ingest the log,
 * update controls, and re-render.
 */
function load_button_handler(event) {
  const [file] = document.querySelector("input[type=file]").files;
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener(
    "load",
    (event) => {
      const log = logname_from_filepath(file.name);
      const lines = reader.result.split(/\r?\n/);
      global_messages = global_messages.concat(parse_log(log, lines));
      reconcile_log_dates(global_messages);
      global_log_counts = tally_logs(global_messages);
      for (let i=0; i<global_messages.length; i++) global_messages[i].gindex=i;
      render_controls();
      const params = new URLSearchParams(window.location.search);
      write_controls(params);
      control_handler(event);
    },
    false
  );
  reader.readAsText(file);
}

/** This is called on changes to controls. Its main response is to recompute
 * the message-list. This method debounces the recoputation.
 * (1) If the user makes a change in a textarea control e.g. the filter or the text,
 *     then we will recompute the message-list. Also we'll adjusts the height
 *     of the textarea to fit everything.
 * (2) If the user clicks a log button or dropdown, or alters the time,
 *     then again we'll recompute the message-list.
 * (3) If the user resizes the window, then surprisingly we might need a debounced
 *     recompute of the message-list. In particular if the resize causes
 *     messages to wrap differently (detected by the new height of the bottom
 *     message to be different from what it was before) then all backgrounds and
 *     lines in the display must be thrown out and recomputed.
 * (4) If the user clicks the load button, then after the load we do a debounced
 *     recompute of the message-list
 * (5) On window.load, after parsing the addendum, we do a debounced recompute
 *     of the message-list
 */
function control_handler(event) {
  // Commonly, we'll use a timeout that's snappy for small message-lists
  // that can be recomputed quickly, and slower for larger lists.
  const displayed_message_length =
    document.getElementById("messages").childElementCount;
  const message_burden =
    displayed_message_length == 0
      ? global_messages.length
      : displayed_message_length;
  let timeout = message_burden > 10000 ? 1000 : message_burden > 3000 ? 250 : 50;
  let update_url = true;

  if (event.type == "init" || event.type == "load") {
    // upon init and load, we'll only have a short timeout to allow the screen to render;
    // we want the messages to be recomputed as soon as rendering is done.
    timeout = 1;
  } else if (event.type == "resize") {
    // upon window-resize, if the wrapping (hence, vertical height) of the message-list
    // hasn't changed then there's no need to recompute anything.
    const lastChild = document.getElementById("messages").lastChild;
    const height =
      lastChild == null ? 0 : lastChild.offsetTop + lastChild.offsetHeight;
    if (height == global_resize_expected_height) return;
    // If we do need to recompute in response to window-resize, we'll do so with
    // a fairly high timeout.
    timeout = 250;
    update_url = false;
  } else if (
    event.type == "change" &&
    (event.target.id == "select_start" || event.target.id == "select_end")
  ) {
    // user clicked on a start/end dropdown. That has already had the effect of updating
    // the start/end inputs, but bypassed their normal firing of events, which is why
    // we handle it.
    // There's no need for debouncing here.
    timeout = 1;
  } else if (event.type == "change" && event.target.id == "time_menu") {
    // user clicked on a time popup. Again, no need for debouncing.
    timeout = 1;
  } else if (event.type == "input" && event.target.id == "input_start") {
    // user typed in the time boxes. Uses normal debounce. Also, deselect the "select" dropdown
    document.getElementById("select_start").selectedIndex = 0;
  } else if (event.type == "input" && event.target.id == "input_end") {
    // user typed in the time boxes. Uses normal debounce. Also, deselect the "select" dropdown
    document.getElementById("select_end").selectedIndex = 0;
  } else if (event.type == "input" && event.target.tagName == "TEXTAREA") {
    // User typed in a textbox.
    // We'll immediately adjust the size of the textbox to fit whatever's there,
    // and update the autocomplete, and kick off a recompute using the normal debounce.
    event.target.style.height = "";
    event.target.style.height = event.target.scrollHeight + "px";
  } else if (
    event.type == "change" &&
    (event.target.id.startsWith("logcheck") ||
      event.target.id.startsWith("logalign"))
  ) {
    // clicked on a checkbox or an alignment button for logs.
    // We'll use standard debounce.
  } else {
    throw new Error(`control_handler ${event.target.id || "?"}.${event.type}`);
  }

  // update URL
  const params = read_controls();
  if (update_url) {
    window.top.postMessage(params.toString(), global_target);
  }

  clearTimeout(global_debounce_timeout);
  global_debounce_timeout = setTimeout(() => {
    // figure out the controls
    const filter = params.has("filter") ? params.get("filter") : defaults.filter;
    const start = params.has("start") ? params.get("start") : defaults.start;
    const end = params.has("end") ? params.get("end") : defaults.end;
    const text = params.has("text") ? params.get("text") : defaults.text;
    const id = params.has("id") ? params.get("id") : defaults.id;
    const color = params.has("color") ? params.get("color") : defaults.color;
    let log_filter={}, log_align={};
    for (const [log, count] of Object.entries(global_log_counts)) {
      const key = `log_${log}`;
      if (params.has(key)) {
        log_filter[log] = !params.get(key).startsWith("hide_");
        log_align[log] = params.get(key).replace(/^hide_/, "");
      } else {
        log_filter[log] = count < defaults.threshold_for_visible;
        log_align[log] = (log == "server" || log.endsWith(":server")) ? defaults.align_for_server_log : defaults.align_for_other_logs;
      }
    }
    let start_time = null, end_time = null, time_exn = null;
    if (start.charAt(0) == "-") {
      try {
        end_time = parseTimeControl(end, global_messages);
      } catch (e) {
        time_exn = time_exn || e;
      }
      try {
        start_time = parseTimeControl(start, global_messages, end_time);
      } catch (e) {
        time_exn = time_exn || e;
      }
    } else {
      try {
        start_time = parseTimeControl(start, global_messages);
      } catch (e) {
        time_exn = time_exn || e;
      }
      try {
        end_time = parseTimeControl(end, global_messages, start_time);
      } catch (e) {
        time_exn = time_exn || e;
      }
    }
    // make functions out of them
    const text_fn = make_fn(text);
    const id_fn = make_fn(id);
    const color_fn = make_fn(color);
    const filter_fn = make_fn(filter || "true");
    const filter2_fn = (m) => log_filter[m.log] && filter_fn(m);
    const align_fn = (m) => log_align[m.log];
    // render into html
    const t0 = performance.now();
    const { messages, filter_exn } = filter_and_sort_messages(
      global_messages,
      filter2_fn,
      start_time,
      end_time
    );
    const t1 = performance.now();
    const { text_exn, id_exn, color_exn } = render_messages(
      messages,
      text_fn,
      id_fn,
      color_fn,
      align_fn
    );
    const t2 = performance.now();
    render_error(document.getElementById("error_filter"), filter_exn);
    render_error(document.getElementById("error_time"), time_exn);
    render_error(document.getElementById("error_text"), text_exn);
    render_error(document.getElementById("error_id"), id_exn);
    render_error(document.getElementById("error_color"), color_exn);
    const t3 = performance.now();
    render_missing_backgrounds();
    const t4 = performance.now();
    // update or hide the persistent details popup
    const mindex = messages.findIndex(
      (m) => m.gindex == global_popup_message_index
    );
    if (mindex == -1 && messages.length > 0) render_popup(null);
    else render_popup(document.getElementById("messages").children[mindex]);
    // set some global values
    const t5 = performance.now();
    global_current_dictionary = build_dictionary(messages);
    const t6 = performance.now();
    const lastChild = document.getElementById("messages").lastChild;
    global_resize_expected_height =
      lastChild == null ? 0 : lastChild.offsetTop + lastChild.offsetHeight;
    // render perf
    const perfElement = document.getElementById("perf");
    let perf = ``;
    perf += `filter_msgs [${(t1-t0).toFixed()}ms]\n`;
    perf += `render_msgs [${(t2-t1).toFixed()}ms]\n`;
    perf += `autocomplet [${(t6-t4).toFixed()}ms]`;
    perfElement.innerText = perf;
    perfElement.style.display = (t5 - t0 > 500) ? 'block' : 'none';
  }, timeout);
}

/** called by a messagetext's onclick handler, for
 * when the user clicks on a message to toggle its details popup.
 */
function message_handler(event, messageDiv, gindex) {
  event.stopPropagation();
  document.getElementById("menu").style.display = "none";
  if (global_popup_message_index == gindex && document.getElementById('popup').style.display == 'block') {
    global_popup_message_index = -1;
    render_popup(null);
  } else {
    global_popup_message_index = gindex;
    render_popup(messageDiv);
  }
}

/** Called by messagetime's onclick handler, for when
 * the user clicks on a time to show a popup which then
 * is able to set the start/end times.
 */
function time_handler(event, time) {
  event.stopPropagation();
  render_popup(null);
  const menu = document.getElementById("menu");
  menu.style.display = "block";
  let html = `<select id='time_menu' multiple size=2>`;
  html += `<option value='start'>set start</option>`;
  html += `<option value='end'>set end</option>`;
  html += `</select>`;
  menu.innerHTML = html;
  const {x, y} = boundPopup(menu, event.target, 'left');
  menu.style.top = `${y}px`;
  menu.style.left = `${x}px`;
  const select = menu.getElementsByTagName("select")[0];
  select.addEventListener("change", (event) => {
    menu.style.display = "none";
    const value = select.options[select.selectedIndex].value;
    const input =
      value == "end"
        ? document.getElementById("input_end")
        : document.getElementById("input_start");
    input.value = formatTimeControl(time, global_messages);
    // we'll also reset the input-time-control dropdown back to "(select)"
    document.getElementById(value == "end" ? "select_end" : "select_start").selectedIndex = 0;
    control_handler(event);
  });
}

/** Called by keyup, click and focus events on a textarea.
 * Its job is to show or hide the autocomplete popup as appropriate.
 * Keyup covers typing and cursoring.
 * Click covers when you click on it to focus, and also when you click to reposition the caret.
 * Focus covers when you click on it to focus, and also when you tab to focus.
 * We often end up getting both Click and Focus e.g. when we gain focus from elsewhere. No matter.
 */
function autocomplete_handler(event) {
  const menuElement = document.getElementById("menu");

  if (event.type == "keyup" && event.key == "Escape") {
    // this handler is invoked to show autocomplete in response to keystrokes,
    // but if the keystroke was an escape then we won't!
    return;
  }
  // This is the entire text leading up to the caret:
  let text = event.target.value.substring(0, event.target.selectionStart);
  // We won't be fancy about nesting, but we will track
  // whether there's an unbalanced number of string quote delimeters
  if (
    text.split('"').length % 2 == 0 ||
    text.split("'").length % 2 == 0 ||
    text.split("`").length % 2 == 0
  )
    text = "";
  // Replace all [...] with .ELEMENT and replace all ?. with .
  text = text.replace(/\[[^\]]*\]/g, ".ELEMENT");
  text = text.replace(/\?\./g, ".");
  // Find the longest identifier+dot string leading to the caret
  const match = text.match(
    /(([a-zA-Z_][a-zA-Z0-9_]*\.)*[a-zA-Z_][a-zA-Z0-9_]*\.?)$/
  );
  text = match ? match[1] : "";
  const identifiers = text.split(".");
  // Walk the identifier chain to find autocomplete up to the second-last identifier in the chain.
  let current = global_current_dictionary;
  for (let i = 0; current != null && i < identifiers.length - 1; i++) {
    current = current[identifiers[i]]?.nested;
  }
  if (current == null) {
    menuElement.style.display = "none";
    return;
  }
  // The last identifier in the chain is the one that the caret is currently on,
  // e.g. for "foo.|" the last identifier will be the empty string, and for "foo|" it will be "foo".
  // We'll use it as a filter to only show some options.
  let filter = identifiers.pop();
  let html = `<table id='autocomplete'>`;
  for (const [k, v] of Object.entries(current)) {
    if (k.startsWith(filter)) {
      html += `<tr><td class="autocomplete_name">${
        k == "ELEMENT" ? "[]" : esc(k)
      }</td><td class="autocomplete_hint">${esc(v.hint)}</td></tr>`;
    }
  }
  html += `</table>`;
  // And render it!
  menuElement.innerHTML = html;
  menuElement.style.display = "block";
  const { x, y } = boundPopup(menuElement, event.target, "left");
  menuElement.style.top = `${y}px`;
  menuElement.style.left = `${x + event.target.offsetWidth}px`;
}

/** Called by the "body" onclick handler, for when the
 * user clicks in the background to dismiss any popups.
 * Also called by the document keydown event handler, for
 * when the user presses escape to dismiss popups.
 */
function hide_popups_handler(event) {
  let dismiss_menu = false;
  let dismiss_popup = false;
  if (event.type == "keydown" && event.key == "Escape") {
    // will dismiss them both
    dismiss_menu = true;
    dismiss_popup = true;
  } else if (event.type == "click") {
    // the time menu will be dismissed by any click not on it
    // the autocomplete popup will be dismissed by any click not on it and not on a textarea
    const menu = document.getElementById("menu");
    if (event.target.offsetParent != menu) dismiss_menu = true;
    if (
      menu.firstChild?.id != "time_menu" &&
      event.target.tagName == "TEXTAREA"
    ) {
      dismiss_menu = false;
    }
    // the details-popup is more sticky: clicking in the #left panel won't dismiss it
    let parent = event.target;
    while (parent != null && parent.id != "left") parent = parent.offsetParent;
    dismiss_popup = parent == null;
  }
  if (dismiss_menu) menu.style.display = "none";
  if (dismiss_popup) {global_popup_message_index = -1; render_popup(null);}
}

// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================
// RENDERING FUNCTIONS INTO THE HTML
// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================
  
/** Seaoflogs will be set up with an empty body, because it initializes its controls here. */
function render_page() {
  const body = document.getElementsByTagName("body")[0];
  body.onclick = hide_popups_handler;
  body.innerHTML = `
  <div id="left">
    <div id="title">
      <table>
        <tr>
          <td><b>Sea of logs</b></td>
          <td>
            <label for="load" id="loadbutton">Load...</label>
            <input type="file" id="load" onchange='load_button_handler(event)' />
          </td>
        </tr>
      </table>
      <hr />
    </div>
    <div id="logs">
      <table id="logs_table"></table>
      <hr />
    </div>
    <div id="time">
      <table>
        <tr>
          <td>Start</td>
          <td>
            <input id="input_start" style="width: 6em;" onfocus="this.select()" oninput='control_handler(event)'
              type="text">
            <select id="select_start" style="width: 2.5ex;"
              onchange="if (this.selectedIndex != 0) {document.getElementById('input_start').value=this.options[this.selectedIndex].value;control_handler(event);}"></select>
          </td>
        </tr>
        <tr>
          <td>End</td>
          <td>
            <input id="input_end" style="width: 6em;" onfocus="this.select()" oninput='control_handler(event)'
              type="text">
            <select id="select_end" style="width: 2.5ex;"
              onchange="if (this.selectedIndex != 0) {document.getElementById('input_end').value=this.options[this.selectedIndex].value;control_handler(event);}"></select>
          </td>
      </table>
      <div class="error" id="error_time" style="display: none;"></div>
      <hr />
    </div>
    <div id="filter">
      Filter<br />
      <textarea id="input_filter" wrap='soft' type='text' oninput='control_handler(event)'
        onclick='autocomplete_handler(event)' onkeyup='autocomplete_handler(event)'
        onfocus='autocomplete_handler(event)'></textarea>
      <div class="error" id="error_filter" style="display: none;"></div>
      <hr />
    </div>
    <div id="text">
      Text<br />
      <textarea id="input_text" wrap="soft" type='text' oninput='control_handler(event)'
        onclick='autocomplete_handler(event)' onkeyup='autocomplete_handler(event)'
        onfocus='autocomplete_handler(event)'>title</textarea>
      <div class="error" id="error_text" style="display: none;"></div>
      <hr />
    </div>
    <div id="color">
      Color<br />
      <textarea id="input_color" wrap="soft" type='text' oninput='control_handler(event)'
        onclick='autocomplete_handler(event)' onkeyup='autocomplete_handler(event)'
        onfocus='autocomplete_handler(event)'>title</textarea>
      <div class="error" id="error_color" style="display: none;"></div>
      <hr />
    </div>
    <div id="id">
      Id<br />
      <textarea id="input_id" wrap="soft" type='text' oninput='control_handler(event)'
        onclick='autocomplete_handler(event)' onkeyup='autocomplete_handler(event)'
        onfocus='autocomplete_handler(event)'>id</textarea>
      <div class="error" id="error_id" style="display: none;"></div>
      <hr />
    </div>
    <div id="details">
      Details<br />
      <textarea id="input_details" wrap="soft" type='text' oninput='control_handler(event)'
        onclick='autocomplete_handler(event)' onkeyup='autocomplete_handler(event)'
        onfocus='autocomplete_handler(event)'>message</textarea>
      <div class="error" id="error_details" style="display: none;"></div>
      <hr />
    </div>
    <pre id="perf"></pre>
  </div>
  <div id="right">
    <div id="backgrounds">
    </div>
    <div id="connectors">
      <svg id="svg" width="100%" height="100" viewbox="0 0 400 100" preserveAspectRatio="none"></svg>
    </div>
    <div id="messages">
      <pre id="loading">Loading...</pre>
    </div>
  </div>
  <div id="popup"></div>
  <div id="menu"></div>`;
}

/** Figures out a good {x,y} for the popup to display related to the element.
 * If align is 'right' then it will align to the right of the element,
 * otherwise to the left.
 */
function boundPopup(popup, element, align) {
  const rPopup = popup.getBoundingClientRect();
  const rElement = element.getBoundingClientRect(); // relative to screen
  const rWindow = { right: window.innerWidth, bottom: window.innerHeight };
  // popup will be offset to the left of right-column, or offset to right of left-column
  // but clipped within bounds
  let x = align == "right" ? rElement.right - rPopup.width : rElement.left;
  if (x + rPopup.width > rWindow.right) x = rWindow.right - rPopup.width;
  if (x < 0) x = 0;
  // popup will go underneath element if it fits, else above if it fits, else underneath
  let y =
    rElement.bottom + rPopup.height < rWindow.bottom
      ? rElement.bottom
      : rElement.top - rPopup.height >= 0
      ? rElement.top - rPopup.height
      : rElement.bottom;
  return { x, y };
}

/** Either shows or hides 'element' according to whether to show the exception
 */
function render_error(element, exn) {
  element.innerText = String(exn);
  element.style.display = exn == null ? "none" : "block";
}

/** Renders this list of messages into html elements #messages, #svg, #backgrounds.
 * Depends on the input messages having additional 'gindex' and 'filter' properties.
 * Returns {text_exn, id_exn, color_exn} for any errors encountered
 */
function render_messages(messages, text_fn, id_fn, color_fn, align_fn) {
  let text_exn = null;
  let id_exn = null;
  let color_exn = null;

  // This is where we'll render to
  const messagesElement = document.getElementById("messages");
  const svgElement = document.getElementById("svg");
  const backgroundsElement = document.getElementById("backgrounds");

  // If anything does throw, these are the values we'll use
  const color_error = "#E00000";
  const text_error = `<span class='error'>error</span>`;

  // Some derived values for layout
  let gaps = []; // gap[i] is the extra padding above message i, where 0=no padding and 1=1 line of padding
  let pos = []; // pos[i] = {left, top, width, height, cx, cy} for message i
  let idmap = {}; // a map {id -> [i1, i2]}, but only listing ones that pass the filter

  // Here we compute 'gaps' derived values, the extra padding above messages.
  // The idea is that messages-with-time go first in the list. If at least three messages
  // have times, then we'll set up the 'gap' array to scale their positions.
  let time_count = messages.findIndex((m) => m.time == null);
  time_count = time_count == -1 ? messages.length : time_count;
  if (time_count >= 3) {
    const earliest_time = messages[0].time;
    const latest_time = messages[time_count - 1].time;
    // Imagine N=time_count messages spread over a vertical axis according to their
    // timestamp, where the vertical axis is 4N tall. This implies the natural "y"
    // of each element, and hence the natural separation between two elements.
    // We will cap the separation into the range [1..5], and define gap=separation-1.
    const yrange = time_count * 4; // 4N
    const timerange = latest_time.getTime() - earliest_time.getTime();
    gaps[0] = 0;
    for (let i = 1; i < time_count; i++) {
      const prev_natural_y =
        ((messages[i - 1].time.getTime() - earliest_time.getTime()) /
          timerange) *
        yrange;
      const natural_y =
        ((messages[i].time.getTime() - earliest_time.getTime()) / timerange) *
        yrange;
      let separation = natural_y - prev_natural_y;
      separation = Math.max(Math.min(separation, 5), 1);
      gaps[i] = separation - 1;
    }
  }
  // Let's place a gap of 4 between messages-with-time and those without,
  // and then all messages-without-time will be adjacent to each other.
  for (let i = time_count; i < messages.length; i++) {
    gaps[i] = i == time_count && i != 0 ? 4 : 0;
  }
  // If every single element was spaced out, we might as well compress them.
  const mingap = Math.min(...gaps.slice(1, time_count - 1));
  for (let i = 1; i < time_count; i++) {
    gaps[i] -= mingap;
  }

  // Render phase 1: this inserts html into messagesElement, and computes pos[] and idmap[]
  let html = "";
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const align = align_fn(m);
    let text;
    try {
      text = esc(text_fn(m));
    } catch (e) {
      text_exn = text_exn || e;
      text = text_error;
    }
    let color;
    try {
      color = color_fn(m);
      if (typeof color === "string" && color.match(/^#[0-9a-fA-F]..(...)?$/)) {
          // it's a color string of the form "#abc" or "#abcdef"
      } else {
          color = hsl((hash(String(color)) % 12) / 12.0, 0.5, 0.9);
      }
    } catch (e) {
      color_exn = color_exn || e;
      color = color_error;
    }
    let ids;
    try {
      ids = id_fn(m);
      if (Array.isArray(ids)) {
        ids = Array.from(new Set(ids.filter(x => x != null).map(x => String(x))).values());
      } else if (ids != null) {
        ids = [String(ids)];
      } else {
        ids = [];
      }
    } catch (e) {
      id_exn = id_exn || e;
      ids = [];
      color = color_error;
    }
    // derived quantities pos[] and idmap[]
    let jiggle = (hash(text) % 6) - 3;
    pos[i] = { cx: align == "right" ? 370 + jiggle : align == "left" ? 30 + jiggle : 200 + jiggle};
    for (const id of ids) {
      if (idmap[id] == null) idmap[id] = [];
      idmap[id].push(i);
    }
    // produce the html for this message
    let time = "";
    if (m.time != null) {
      time = formatCompactTime(m.time);
      time = `<span class='messagetime'>${
        align == "right" ? "&nbsp;" : ""
      }${time}${align == "right" ? "" : "&nbsp;"}</span>`;
    }
    let time_right = align == "right" ? time : "";
    let time_left = align == "right" ? "" : time;
    const gap = gaps[i] == 0 ? "" : `margin-top: ${gaps[i] * 3}ex;`;
    const s = `<div class="message" style='text-align: ${align}; ${gap}' data-color='${color}'><span class="messageall">${time_left}<span class="messagetext">${text}</span>${time_right}</span></div>`;
    html += s;
  }
  messagesElement.innerHTML = html;

  // Render phase 2: uses the message elements that have been created to obtain
  // layout information, set up handlers on them, and completes pos[]
  for (let i = 0; i < messages.length; i++) {
    const element = messagesElement.children[i];
    const message = messages[i];
    const gindex = message.gindex;
    const textspan = element.getElementsByClassName("messagetext")[0]; // should definitely be there
    const timespan = element.getElementsByClassName("messagetime")[0]; // may not be there
    textspan.addEventListener("click", (event) =>
      message_handler(event, element, gindex)
    );
    timespan?.addEventListener("click", (event) =>
      time_handler(event, message.time)
    );
    timespan?.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      time_handler(event, message.time);
    });
    pos[i] = {
      left: element.offsetLeft,
      top: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
      cx: pos[i].cx,
      cy: element.offsetTop + element.offsetHeight / 2,
    };
  }

  // Render phase 3: update svg, which contains the lines.
  // The svg element will have "width=100% height=<natural_height>" to fill entire space.
  // The viewbox will have "width=400 height=<natural_height>"
  // so that coordinates of elements will be normalized to an X range [0..400]
  // and a Y range identical to the pixel positions of the elements
  const lastChild = messagesElement.lastChild;
  const height =
    lastChild == null ? 0 : lastChild.offsetTop + lastChild.offsetHeight;
  svgElement.setAttribute("height", height);
  svgElement.setAttribute("viewBox", `0 0 400 ${height}`);
  // Now assemble the content of the svg, i.e. the id lines
  let svg = "";
  for (const [id, indexes] of Object.entries(idmap)) {
    if (indexes.length <= 1) continue;
    const color = hsl((hash(id) % 12) / 12.0, 0.9, 0.4);
    for (let vi = 0; vi < indexes.length - 1; vi++) {
      const m1 = indexes[vi];
      const m2 = indexes[vi + 1];
      svg += `<line x1='${pos[m1].cx}' y1='${pos[m1].cy}' x2='${pos[m2].cx}' y2='${pos[m2].cy}' stroke='${color}'/>`;
    }
    for (let vi = 0; vi < indexes.length; vi++) {
      const m1 = indexes[vi];
      svg += `<ellipse cx='${pos[m1].cx}' cy='${pos[m1].cy}' rx='1' ry='2' fill='${color}'/>`;
    }
  }
  svgElement.innerHTML = svg;

  // As for backgrounds, they're not done here; they're all provided lazily
  // by render_missing_backgrounds. That's because assembling a load of html
  // is the bottleneck, and we don't want to do more of it than necessary
  backgroundsElement.innerHTML = "";

  return { text_exn, id_exn, color_exn };
}

/** Generate any needed background divs that (lazily) were deferred
 * until they scrolled into view.
 */
function render_missing_backgrounds() {
  const container = document.getElementById("messages");
  // let's bisect to find the first child visible in the viewport
  // i.e. the first element whose bottom is > 0
  let ifirst = 0;
  let ilast = container.childElementCount;
  while (ilast - ifirst > 1) {
    const i = Math.floor((ifirst + ilast) / 2);
    const r = container.children[i].getBoundingClientRect();
    if (r.bottom > 0) ilast = i;
    else if (r.bottom <= 0) ifirst = i;
  }
  for (let i = ifirst; i < container.childElementCount; i++) {
    const element = container.children[i];
    const r = element.getBoundingClientRect();
    if (r.top > container.offsetHeight) return;
    const color = element.getAttribute("data-color");
    if (color == null) continue;
    element.removeAttribute("data-color", null);
    const span = element.children[0];
    const html = `<div class='background' style='position:relative; width:100%; height:0; margin:0; top:${element.offsetTop}px; text-align:${element.style.textAlign};'><span style='display:inline-block; width:${span.offsetWidth}px; height:${span.offsetHeight}px; background-color:${color};'></span></div>`;
    document
      .getElementById("backgrounds")
      .insertAdjacentHTML("beforeend", html);
  }
}

/** Either hides the details-popup (if given null) or renders
 * the message in 'global_messages[global_popup_message_index]'
 * and attaches it to the messageDiv.
 * Note: this function reads the url query parameters for the code
 * to generate details; this query parameters were previously
 * written by control_handler.
 */
function render_popup(messageDiv) {
  // close the existing popup if necessary
  render_error(document.getElementById("error_details"), null);
  document.getElementById("popup").style.display = "none";
  if (messageDiv == null) return;
  // recompute the new popup value
  const params = new URLSearchParams(window.location.search);
  const details_fn = make_fn(params.get("details") || "message");
  let details_exn = null;
  let details;
  try {
    details = details_fn(global_messages[global_popup_message_index]);
  } catch (e) {
    details = String(e);
    details_exn = e;
  }
  if (details == null) return;
  // render the popup
  if (details_exn == null) popup.innerText = details;
  else
    popup.innerHTML = `<span class="error">${esc(String(details_exn))}</span>`;
  popup.style.display = "block";
  let { x, y } = boundPopup(
    popup,
    messageDiv.getElementsByClassName("messagetext")[0],
    messageDiv.style.textAlign
  );
  const rMessagesDiv = document
    .getElementById("messages")
    .getBoundingClientRect();
  y -= rMessagesDiv.top;
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
  // Update error if necessary
  render_error(document.getElementById("error_details"), details_exn);
}

/* Reads current controls. Returns a URLSearchParams with the following keys:
 * log_<name>_checked:bool, log_<name>_align:left|right|center, filter,start,end,text,id,color,details:string
 */
function read_controls() {
  let params = new URLSearchParams();
  const filter = document.getElementById("input_filter").value;
  const start = document.getElementById("input_start").value;
  const end = document.getElementById("input_end").value;
  const text = document.getElementById("input_text").value;
  const id = document.getElementById("input_id").value;
  const color = document.getElementById("input_color").value;
  const details = document.getElementById("input_details").value;
  if (filter != defaults.filter) params.set("filter", filter);
  if (start != defaults.start) params.set("start", start);
  if (end != defaults.end) params.set("end", end);
  if (text != defaults.text) params.set("text", text);
  if (id != defaults.id) params.set("id", id);
  if (color != defaults.color) params.set("color", color);
  if (details != defaults.details) params.set("details", details);
  for (const div of document.getElementsByClassName("log")) {
    const checkboxElement = div.getElementsByTagName("input")[0];
    const alignElement = div.getElementsByTagName("select")[0];
    const key = div.getAttribute("id"); // e.g. "log_client"
    const value = checkboxElement.checked
      ? alignElement.value
      : "hide_" + alignElement.value; // e.g. "left" or "hide_center"
    const log = key.replace(/^log_/, "");
    const def_checked = (global_log_counts[log] < defaults.threshold_for_visible) ? "" : "hide_";
    const def_align = (log == "server" || log.endsWith(":server")) ? defaults.align_for_server_log : defaults.align_for_other_logs;
    if (value == `${def_checked}${def_align}`) continue;
    params.set(key, value);
  }
  return params;
}

/** Writes a URLSearchParams into the UI controls
 */
function write_controls(params) {
  const write = (element, paramName, def) => {
    element.value = params.has(paramName) ? params.get(paramName) : def;
  };
  write(document.getElementById("input_filter"), "filter", defaults.filter);
  write(document.getElementById("input_start"), "start", defaults.start);
  write(document.getElementById("input_end"), "end", defaults.end);
  write(document.getElementById("input_text"), "text", defaults.text);
  write(document.getElementById("input_id"), "id", defaults.id);
  write(document.getElementById("input_color"), "color", defaults.color);
  write(document.getElementById("input_details"), "details", defaults.details);
  for (const div of document.getElementsByClassName("log")) {
    const checkboxElement = div.getElementsByTagName("input")[0];
    const alignElement = div.getElementsByTagName("select")[0];
    const key = div.getAttribute("id"); // e.g. "log_client"
    const log = key.replace(/^log_/, "");
    if (params.has(key)) {
      const value = params.get(key);
      checkboxElement.checked = !value.startsWith('hide_');
      alignElement.value = value.replace(/^hide_/, "");
    } else {
      checkboxElement.checked = global_log_counts[log] < defaults.threshold_for_visible;
      alignElement.value = (log == "server" || log.endsWith(":server")) ? defaults.align_for_server_log : defaults.align_for_other_logs;
    }
  }
}

/** Adds a new log dropdown. 'count' is a number to show to its right.
 */
function append_log_control(log, count) {
  const name = log == null ? "null" : log;
  let html = "";
  html += `<td class="td_logleft" >`;
  html += `<input id='logcheck_${name}' onchange='control_handler(event)' type='checkbox' checked/>`;
  html += `<label for='logcheck_${name}'>${name}</label> <span class='logcount'>${count.toLocaleString()}</span></td>`;
  html += `<td class="td_logright"><select id='logalign_${name}' onchange='control_handler(event)'>`;
  html += `<option value="left" selected>L</option>`;
  html += `<option value="center">C</option>`;
  html += `<option value="right">R</option>`;
  html += `</select></td>`;
  const table = document.getElementById("logs_table");
  const tr = table.insertRow(table.rows.length);
  tr.className = "log";
  tr.id = `log_${name}`;
  tr.innerHTML = html;
}

/**
 * Reads through the 'global_messages' to see what logs-controls should be shown,
 * reads the UI to see what log-controls are already shown,
 * and adds to the UI any log-controls that are needed. Picks sensible 'align' defaults
 * for them too.
 * Note: the log controls include the filter/alignment section and the time section.
 */
function render_controls() {
  // What log controls do we want to show?
  let logs = []; // ordered list of lognames
  let seen = new Set();
  for (const m of global_messages) {
    if (!seen.has(m.log)) {logs.push(m.log); seen.add(m.log);}
  }
  // Add in whichever ones aren't already shown
  for (const log of logs) {
    if (document.getElementById(`logcheck_${log}`) != null) continue;
    append_log_control(log, global_log_counts[log]);
  }
  document.getElementById('logs').style.display = logs.length > 0 ? 'block' : 'none';
  // What time controls do we want to show?
  let extremes = {};
  let earliest = null;
  let latest = null;
  for (const m of global_messages) {
    if (extremes[m.log] == null)
      extremes[m.log] = { earliest: null, latest: null };
    if (m.time == null) continue;
    if (earliest == null || m.time < earliest) earliest = m.time;
    if (latest == null || m.time > latest) latest = m.time;
    if (extremes[m.log].earliest == null || m.time < extremes[m.log].earliest)
      extremes[m.log].earliest = m.time;
    if (extremes[m.log].latest == null || m.time > extremes[m.log].latest)
      extremes[m.log].latest = m.time;
  }
  if (earliest == null) {
    document.getElementById("time").style.display = "none";
    return;
  }
  document.getElementById("time").style.display = "block";
  let s;
  s = formatTimeControl(earliest, global_messages);
  let html_start = `<option>(select)</option><option></option><option value='${s}'>${s}</option>`;
  s = formatTimeControl(latest, global_messages);
  let html_end = `<option>(select)</option><option></option><option value='${s}'>${s}</option>`;
  html_end += `<option value='+5s'>+5s</option>`;
  html_end += `<option value='+10 minutes'>+10 minutes</option>`;
  for (const log of logs) {
    if (extremes[log].earliest != null) {
      const s = formatTimeControl(extremes[log].earliest, global_messages);
      html_start += `<option value='${s}'>${s} - ${log}</option>`;
    }
    if (extremes[log].latest != null) {
      const s = formatTimeControl(extremes[log].latest, global_messages);
      html_end += `<option value='${s}'>${s} - ${log}</option>`;
    }
  }
  document.getElementById("select_start").innerHTML = html_start;
  document.getElementById("select_end").innerHTML = html_end;
}

// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================
// LOGIC
// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================

const defaults = {
  filter: "",
  start: "",
  end: "",
  text: "title || line",
  id: "id",
  color: "title",
  details: "message",
  align_for_other_logs: "left",
  align_for_server_log: "right",
  threshold_for_visible: 2000,
};

/** Given a list of messages, returns {logname->count}.
 */
function tally_logs(messages) {
  let counts = {}; // map from logname to number of messages in that log
  for (const m of messages) {
    if (counts[m.log] == null) counts[m.log] = 0;
    counts[m.log] += 1;
  }
  return counts;
}

/** Returns a filtered+sorted list of messages to display.
 * source:message[]' is a list of messages.
 * 'filter_fn:m->bool' is a predicate on messages.
 * 'start:Date?' and 'end:Date?' are times.
 * Returns {messages: message[], filter_exn}
 * Each message returned actually has an additional property 'gindex',
 * for the index into the source list, and some have 'filter' if
 * the filter function failed on them.
 */
function filter_and_sort_messages(source, filter_fn, start, end) {
  let filter_exn = null;

  // We'll stable-sort all messages by time, but putting unstamped messages at the end.
  // We also add a property 'gindex' to the messages in our local 'messages' array,
  // for the index into the global messages list, and an optional property
  // 'filter' which has value null for everything that couldn't be filtered.
  let messages = [];
  for (let gindex=0; gindex<global_messages.length; gindex++) {
    const m = global_messages[gindex];
    if (start != null && (m.time == null || m.time < start)) continue;
    if (end != null && (m.time == null || m.time > end)) continue;
    try {
      if (filter_fn(m)) messages.push(m);
    } catch (e) {
      filter_exn = filter_exn || e;
      messages.push(m); // still shown even with error
    }
  }
  messages.sort((a, b) =>
    a.time == null && b.time == null
      ? 0
      : b.time == null
      ? -1
      : a.time == null
      ? 1
      : a.time < b.time
      ? -1
      : b.time < a.time
      ? 1
      : 0
  );
  return { messages, filter_exn };
}

/** Attempts to parse the string as a date/time in a few common log idioms. Test cases at https://jsfiddle.net/z6g20nq1/1/ */
function tryParseLogTime(s) {
  const match = s.match(/(?<y>\d\d\d\d)-(?<m>\d\d)-(?<d>\d\d) (?<hh>\d\d):(?<mm>\d\d):(?<ss>\d\d).(?<ms>\d\d\d)/) || // 2021-11-12 06:53:11.230
      s.match(/(?<hh>\d\d):(?<mm>\d\d):(?<ss>\d\d).(?<ms>\d\d\d)/) || // 06:53:11.230
      s.match(/(?<y>\d\d\d\d)-(?<m>\d\d)-(?<d>\d\d) (?<hh>\d\d):(?<mm>\d\d):(?<ss>\d\d)/) || // 2021-11-12 06:53:11
      s.match(/(?<hh>\d\d):(?<mm>\d\d):(?<ss>\d\d)/) || // 06:53:11
      s.match(/(?<m>\d+)\/(?<d>\d+)\/(?<y>\d+), (?<hh>\d+):(?<mm>\d+):(?<ss>\d+)() (?<ampm>(AM|PM))?/) || // 10/26/2021, 9:43:06 PM
      s.match(/(?<hh>\d+):(?<mm>\d+):(?<ss>\d+) (?<ampm>(AM|PM))/); // 9:43:06 PM
  if (!match) return null;
  const y = parseInt(match.groups.y) || 1970;
  const m = parseInt(match.groups.m) || 1; // 1-based
  const d = parseInt(match.groups.d) || 1; // 1-based
  const hh = parseInt(match.groups.hh) + (match.groups.ampm == 'PM' || match.groups.ampm == 'pm' ? 12 : 0)
  const mm = parseInt(match.groups.mm);
  const ss = parseInt(match.groups.ss);
  const ms = parseInt(match.groups.ms) || 0;
  return new Date(Date.UTC(y, m-1, d, hh, mm, ss, ms)); // uses 0-based month, 1-based day
}

/**
 * We are given the non-null string name of the log we're currently processing,
 * and the time of the previous log entry (may be null of no previous entries
 * in this log had a time), and a list of non-blank lines followed by blank lines.
 * If the first line doesn't start with '[' then we must have been given trivia
 * and so return null.
 */
function parse_message(log, prev_time, lines) {
  // Cleanup: if we're given a message which doesn't start with [, it must have been the initial preamble, so we delete it.
  // Cleanup: if our message ends in newlines, we'll remove them.
  // Cleanup: if we don't even have anything left, we'll skip.
  while (lines.slice(-1)[0] == "") {
    lines.pop();
  }
  if (lines.length == 0 || !line_starts_message(lines[0])) {
    return null;
  }

  const message = lines.join("\n");

  // Gather an initial contiguous sequence of "tags".
  // A tag is something enclosed with square brackets, with optional whitespace after the closing square bracket,
  // that doesn't itself contain any brackets or braces or parentheses.
  // We strip leading and trailing whitespace from tags.
  let s = lines[0];
  let tags = [];
  {
    const match = s.match(/^([^\[ ]*) /);
    if (match) {
      tags.push(match[1]);
      s = s.slice(match[0].length);
    }
  }
  while (true) {
    const match = s.match(/^\[ *([^\]\{\}\(\)]+)\] */);
    if (!match) break;
    tags.push(match[1].replace(/ *$/, ""));
    s = s.slice(match[0].length);
  }

  s = s.replace(/^: */,'');

  const line = s;

  // The optional "title" is a series of alphanumerics without punctuation
  let title = null;
  {
    const match = s.match(/^ *([A-Za-z0-9_][^:'"\{/\[\()]*)([:'"\{\[/\()]) */);
    if (match) {
      title = match[1].replace(/ *$/, "");
      s = s.slice(match[0].length);
      if (match[2] != ":") {
        s = match[2] + s;
      }
    } else {
      const match2 = s.match(/^ *([A-Za-z0-9_][^:'"\{/\[\()]*)$/);
      if (match2) {
        title = match2[1].replace(/ *$/, "");
        s = "";
      }
    }
  }

  let body = s;

  // Can we extract any filenames out of the rest of the line?
  let filename = null;
  {
    const match = (" " + s).match(/([ '"])(\/[0-9A-Za-z/_\-.]*)/);
    if (match) {
      filename = match[2].split("\\").pop().split("/").pop();
    }
  }

  // Can we extract json from the rest of the line plus all subsequent lines?
  let json = null;
  {
    // attempt 1: start json at the first { or [ we see on the first line, plus all subsequent lines
    let ji = s.indexOf("{");
    if (ji == -1) ji = s.indexOf('[');
    if (ji != -1) json = parse_json_relaxed(s.slice(ji) + "\n" + lines.slice(1).join("\n"));
    // attempt 2: look only on subsequent lines
    if (json == null) json = parse_json_relaxed(lines.slice(1).join("\n"));
  }

  // Does one of the tags look like a timestamp? or have the form "...#..."?
  // We'll turn tags from a list into an object, with a member 'anon' for an
  // array of the unrecognized ones.
  let time = null;
  let id = null;
  let oldtags = tags;
  tags = { positional: [] };
  const first_tag = oldtags.length == 0 ? null : oldtags[0];
  if (['INFO','DEBUG','ERROR'].includes(first_tag)) {
    tags['kind'] = first_tag;
    oldtags.shift();
  }
  for (const tag of oldtags) {
    const match_time = tryParseLogTime(tag);
    if (match_time) {
      time = match_time;
    } else {
      const match_id = tag.match(/^([A-Za-z]*)#.*$/);
      if (match_id) {
        if (match_id[1] == "") {
          id = tag;
        } else {
          tags[match_id[1]] = tag;
          id = id || tag;
        }
      } else {
        tags.positional.push(tag);
      }
    }
  }

  // LSP messages have a particular format.
  {
    const match = lines[0].match(
      /^\[Trace - (?<time>[^\]]*)\] (?<dir>(Sending|Received)) (?<kind>(request|response|notification)) '(?<method_and_id>[^']*)' *(?<body>.*)$/
    );
    const lsp_time = match ? tryParseLogTime(match.groups.time) : null;
    if (match && lsp_time) {
      time = lsp_time;
      log = `${log == "(default)" ? "" : log + ':'}${match.groups.dir == "Sending" ? "client" : "server"}`;
      title = match.groups.method_and_id.replace(/ - \(.*\)$/,''); // e.g. 'textDocument/didChange'
      body = match.groups.body;
      json = lines
        .slice(1)
        .join("\n")
        .replace(/^(Result|Params|Error): /, "");
      try {
        json = JSON.parse(json);
      } catch (e) {
        json = null; // includes the case "No result returned"
      }
      // Some traces have json {jsonrpc:, id:, params|result|error: }
      // Others merely have the params/result/error
      let root;
      let kind;
      if (json?.hasOwnProperty('jsonrpc')) {
        id = json.id;
        kind = id == null ? "notification" : json.result != null || json.error != null ? "response" : "request";
        root = json.params;
      } else {
        const matchid = match.groups.method_and_id.match(/ - \((.*)\)$/);
        id = (matchid) ? matchid[1] : null;
        kind = match.groups.kind;
        root = json;
      }
      // ids generated by the server are in a different namespace from those generated by the client
      let originate_by_server = (log == "server" || log.endsWith(":server")) ? true : false;
      if (kind == "response") originate_by_server = !originate_by_server;
      if (originate_by_server && id != null) id = `s#${id}`;
      // cancelRequest notification is about this particular id
      if (title == '$/cancelRequest') id = root.id;
      // for filename, heuristic is to pick either textDocument.uri, or the first didWatcheFilesChanged filename
      const change0 = root?.changes?.length > 0 ? root?.changes[0] : null;
      const uri = root?.textDocument?.uri || root?.uri || change0?.uri;
      filename = uri?.split("\\").pop().split("/").pop();

      tags = { kind };
    }
  }

  // Some logs have timestamps that omit the year/month/day; they have only time-of-day.
  // To handle wraparound at midnight, we'll say that if a such subsequent message
  // is earlier that the previous one, then it must be one day ahead.
  if (time != null && time.getUTCFullYear() == 1970 && prev_time != null) {
    while (time < prev_time) time.setUTCDate(time.getUTCDate() + 1);
  }
  time = time || prev_time;  

  return {
    log,
    message,
    tags,
    time,
    line,
    title,
    body,
    id,
    filename,
    json,
  };
}

/** Heuristic for whether this line starts a message.
 */
function line_starts_message(line) {
  return line.startsWith('[')
    || line.startsWith('INFO [')
    || line.startsWith('DEBUG [')
    || line.startsWith('ERROR [');
}

/**
 * Given the string name of a logfile we're processing (or "(default)" if it
 * lacks a name), and its content, parse it into a list of messages and 
 * return that list.
 */
function parse_log(log, lines) {
  // A log's text is a series of "messages" with trivia between them.
  // A message is defined as starting on a line whose first character
  // is "[", followed by a series of non-blank lines which themselves
  // don't start with "[".
  let messages = [];
  let prev_time = null;
  let acc = [];
  for (const line of lines) {
    if (line_starts_message(line)) {
      const m = parse_message(log, prev_time, acc);
      prev_time = m?.time || prev_time;
      messages.push(m);
      acc = [];
    }
    acc.push(line);
  }
  const m = parse_message(log, prev_time, acc);
  prev_time = m?.time || prev_time;
  messages.push(m);
  // Filter out all cases where parse_message return null for it just being trivia
  messages = messages.filter((m) => m != null);
  // Invariant: starting from the first message to have a parseable timestamp,
  // it and all subsequent messages have monotonically ascending timestamps,
  // and none of the earlier ones do, and prev_time is the timestamp of the last message.
  // We'll use that fact to backfill the timestamp-less messages if possible:
  for (const m of messages) {
    if (m.time == null) m.time = prev_time;
  }
  // Invariant: either every message has a timestamp, or none of them do.

  return messages;
}


/** If the log contains some messages that are fully-dated e.g. 2021-11-18, and
 * other messages maybe from an LSP trace which don't have dates and are stored
 * starting 1970-01-01, then this method rewrites the undated messages to start
 * at the earliest full date.
 * Note: some logs are entirely undated. They're skipped by this method.
*/
function reconcile_log_dates(messages) {
  // Context:
  // Some log formats include dates "2021-11-12 14:44:00" but LSP traces typically don't "2:44:00 PM".
  // How can we support (1) scenario where the addendum has one log that starts on 2021-11-18 and
  // a fully-dated LSP trace that starts on 2021-11-19, the next day? (2) scenario where the user
  // loads an undated LSP trace and wants it to look reasonable? (3) scenario where the user
  // loads an undated LSP trace that starts on 2021-11-19 and then afterwards loads a fully-dated
  // other log that also starts on 2021-11-19 and wants to see them interleaved? (4) reverse
  // where the user first loads the fully-dated other log and then loads the undated LSP trace
  // where both start on the same day? -- That's what this method achieves.

  // But, when parsing a log, we "increment the date" if ever we see a time followed
  // by an earlier time, e.g. 23:50:05 followed by 00:02:03. If there was an undated
  // log with more than 365 such resets, its year won't be 1970 any longer, and
  // this logic will fail.
  let earliest = null;
  for (const m of messages) {
    if (m.time == null) continue;
    if (m.time.getUTCFullYear() == 1970) continue;
    if (earliest == null) earliest = m.time;
    if (m.time < earliest) earliest = m.time;
  }
  if (!earliest) return;
  earliest = new Date(earliest);
  earliest.setUTCHours(0);
  earliest.setUTCMinutes(0);
  earliest.setUTCSeconds(0);
  earliest.setUTCMilliseconds(0);
  const offset = earliest.valueOf();
  // e.g. if first timestamp was "2021-11-12 14:44:00", then offset is the number
  // of milliseconds to add to "1970-01-01 09:17:00" to get "2021-11-12 09:17:00"
  for (const m of messages) {
    if (m.time == null) continue;
    if (m.time.getUTCFullYear() != 1970) continue;
    m.time = new Date(m.time.valueOf() + offset);
  }
}

/** Given a list of messages, constructs and returns an autocomplete dictionary for it.
 *  Example: this list of messages
 *   [log1] foo {addr: 'hello', age: 47, cols: [1,2,3]}
 *   [log2] bar {addr: 'world', age: 53, cols: []}
 *   [log3] baz {addr: 'there', cols: []}
 * produces this dictionary:
 * { title: { hint:[string], nested: null},
 *   json: { hint:[object], nested: {
 *     addr: { hint:[string], nested:null},
 *     age: { hint:[num|undefined], nested:null},
 *     cols: [hint:[array], nested: {ELEMENT: {hint:[num],nested:null}}
 * }
 */
function build_dictionary(messages) {
  // We'll first construct everything 'positively' from the members that are present
  let dictionary = {};
  if (messages.length == 0) return dictionary;
  let add;
  add = (dict, prop, value, allowRecurse) => {
    if (dict[prop] == null) dict[prop] = { hint: new Set(), nested: null };
    let type;
    if (value === null) type = "null";
    else if (value === "") type = "empty_string";
    else if (value instanceof Date) type = "Date";
    else type = typeof value;
    if (Array.isArray(value)) {
      if (dict[prop].nested == null) dict[prop].nested = {};
      for (const v of value) {
        add(dict[prop].nested, "ELEMENT", v, true);
      }
    } else if (type == "object") {
      if (allowRecurse) {
        if (dict[prop].nested == null) dict[prop].nested = {};
        for (const [k, v] of Object.entries(value)) {
          add(dict[prop].nested, k, v, true);
        }
      }
    } else {
      dict[prop].hint.add(type);
    }
  };
  for (const m of messages) {
    for (const [k, v] of Object.entries(m)) {
      add(dictionary, k, v, k == "json" || k == "tags");
    }
  }

  // Now sprinkly in 'undefined' for members that aren't always present
  let undef;
  undef = (dict, value) => {
    if (value == null || typeof value != "object") value = {};
    for (const [k, v] of Object.entries(dict)) {
      if (k == "ELEMENT") {
        if (!Array.isArray(value)) {
          v.hint.add("undefined");
        } else if (dict["ELEMENT"].nested != null) {
          for (const e of value) {
            undef(dict["ELEMENT"].nested, e);
          }
        }
      } else {
        if (!value.hasOwnProperty(k)) v.hint.add("undefined");
        if (v.nested != null) undef(dict[k].nested, value[k]);
      }
    }
  };
  for (const m of messages) {
    undef(dictionary, m);
  }

  // Now combine all those 'primitive' hints into a hint, and provide extra hints for the top level
  let hintify;
  hintify = (dict) => {
    for (const [k, v] of Object.entries(dict)) {
      let types = [...v.hint];
      if (v.nested != null) {
        if (v.nested.hasOwnProperty("ELEMENT")) {
          types.push("array");
          if (Object.entries(v.nested).length > 1) types.push("object");
        } else {
          types.push("object");
        }
      }
      v.hint = types.length == 0 ? "none" : types.join(" | ");
      if (v.nested != null) hintify(v.nested);
    }
  };
  hintify(dictionary);
  dictionary.log.hint +=
    '  -- which logfile it came in; for lsp is "client / server"';
  dictionary.message.hint += "  -- the entire message";
  dictionary.tags.hint +=
    "  -- a list of any [...] tags at the start of the message, other than time-like ones";
  dictionary.time.hint +=
    "  -- one of the timelike [...] tag from the start of the message";
  dictionary.line.hint +=
    "  -- the first line of the message, after all the tags";
  dictionary.title.hint +=
    '  -- if line had the form "title: body" then this is the title';
  dictionary.body.hint +=
    "  -- this is however much of line after the title has been removed";
  dictionary.id.hint +=
    "  -- best-guess as to the most important id; for lsp cancellation the id being cancelled";
  dictionary.filename.hint +=
    "  --  best-guess as to an (unqualified) filename found in the message";
  dictionary.json.hint +=
    "  -- best-guess if the end of the message looked like json object or array";
  return dictionary;
}

// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================
// HELPERS
// ===================================================================
// ===================================================================
// ===================================================================
// ===================================================================

/** Given a filename like "/foo/bar/fred.txt" returns "fred"
 */
function logname_from_filepath(filepath) {
  const filename = filepath.split("\\").pop().split("/").pop();
  const extension = filename.lastIndexOf(".");
  if (extension >= 3 && extension < filename.length - 3)
    return filename.substring(0, extension);
  return filename;
}

/** Attempt to parse it first as proper json, else as heuristic relaxed json.
 * Returns null if it couldn't be parsed.
 * CARE: we must never 'eval' log input. That's why we use regexps to
 * approximate turning relaxed json into proper json.
 */
function parse_json_relaxed(s) {
  if (!s.match(/^ *[\[\{]/)) return null;
  try { return JSON.parse(s); } catch (e) {}
  // relaxed json: we'll use double-quotes not single-quotes for keys and values
  // This will also affect single-quotes inside values, but it's the log's
  // fault for using relaxed json in the first place so you get what you get...
  s = s.replace(/'/g, '"');
  // we'll escape any colons inside values
  s = s.replace(/:\s*"([^"]*)"/g, function(match, p1) {
    return ': "' + p1.replace(/:/g, '@colon@') + '"';
  })
  // put quotes around unquoted identifiers
  s = s.replace(/([a-z0-9A-Z_]+):/g, '"$1": ');
  // undefined
  s = s.replace(/"([a-z0-9A-Z_]+)":\s*undefined,?/g, '');
  // unescape colons
  s = s.replace(/@colon@/g, ':');
  try { return JSON.parse(s); } catch (e) {}
  return null;
}

/** Given a string, renders it suitable for html e.g. `<p>${esc(s)}</p>`
 */
function esc(s) {
  if (s == null) return "&nbsp;";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Pads a number with leading zeros to take it up to length 2,
 * or some other number specified in 'n'. */
function pad2(s, n) {
  s = String(s);
  while (s.length < (n || 2)) s = "0" + s;
  return s;
};

/** Given a Date object, returns an dateless and millisecondless "18:23:15" time to show
 * next to the message
 */
 function formatCompactTime(time) {
  const hh = pad2(time.getUTCHours());
  const mm = pad2(time.getUTCMinutes());
  const ss = pad2(time.getUTCSeconds());
  return `${hh}:${mm}:${ss}`;
}


/** We strive to display time-control with just times "18:23:15" even though logs have
 * full dates "2021-11-13 18:23:15", and some undated logs like LSP have epoch-relative
 * full dates "1970-01-01 18:23:15". We do this with reference to a "reference time"
 * which is the date part "2021-11-13 / 1970-01-01" of the first log message to have a time.
 * This function returns that reference time.
 */
function referenceForTimeControl(messages) {
  const m = messages.find(m => m.time != null);
  if (!m) return null;
  let t = new Date(m.time);
  t.setUTCHours(0);
  t.setUTCMinutes(0);
  t.setUTCSeconds(0);
  t.setUTCMilliseconds(0);
  return t;
}

/** Given a Date object, returns something for the time controls to show.
 * We make use of a "reference date" derived from the messages list.
 * For instance, given reference date "2021-11-13" then we'd display
 * "2021-11-14 18:23:15.123" as "18:23:15.123 (+1day)"
 * Note: this also works if the reference date is "1970-01-01" indicating
 * an undated log, and the date we're given is "1970-01-01"
 * If no reference time is provided, then the user has no business using
 * time filters, so we'll solely display the time part.
 */
function formatTimeControl(time, messages) {
  const ms = time.getUTCMilliseconds() == 0 ? "" : "." + pad2(time.getUTCMilliseconds(), 3);
  const hms = `${formatCompactTime(time)}${ms}`;
  const ref = referenceForTimeControl(messages);
  if (ref == null) return hms;
  // Calculate number of days between 'ref' and 'time'
  // We'll do it by constructing UTC objects, since they don't have daylight saving
  // and hence each day is exactly 24hrs long always.
  const start = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  const end = Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate());
  const plusDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
  if (plusDays == 0) return hms;
  return `${hms} (${plusDays > 0 ? "+" : "-"}${Math.abs(plusDays)}day${Math.abs(plusDays) == 1 ? "" : "s"})`;
}

/** Given a string from a time control, parses it into a time. This is recognized:
 *   null/empty string -> returns null
 *   yyyy-mm-dd hh:mm:ss(.mmm)?
 * If the messages list provides a reference date, then we also recognize:
 *   hh:mm:ss(.mmm)? -> uses yyyy-mm-dd from reference date
 *   hh:mm:ss(.mmm)? (+|-D ?days?) -> D days before or after the reference date
 * If a Date object "relativeTo" is provided then a few additional formats are recognized:
 *   (+|-)N s(econds)?|m(inutes)?|h(ours)?
 * If the string can't be parsed, throw a descriptive human-readable exception text
 */
function parseTimeControl(time, messages, relativeTo) {
  if (time == null || time == "") return null;
  if (time.match(/^\d\d\d/) || time.match(/^\d+\//)) {
    // starts with year
    const match = time.match(
      /^(?<y>\d+)-(?<m>\d+)-(?<d>\d+) (?<hh>\d+):(?<mm>\d+):(?<ss>\d+)(\.(?<ms>\d\d\d))?$/
    );
    if (!match) throw new Error("expected yyyy-mm-dd hh:mm:ss");
    const y = parseInt(match.groups.y);
    const m = parseInt(match.groups.m); // 1-based
    const d = parseInt(match.groups.d); // 1-based
    const hh = parseInt(match.groups.hh);
    const mm = parseInt(match.groups.mm);
    const ss = parseInt(match.groups.ss);
    const ms = parseInt(match.groups.ms) || 0;
    return new Date(Date.UTC(y, m-1, d, hh, mm, ss, ms)); // uses 0-based month, 1-based day
  } else if (time.match(/^\d/)) {
    // starts with hours
    const match = time.match(/^(?<hh>\d+):(?<mm>\d+):(?<ss>\d+)(\.(?<ms>\d\d\d))?(?<rest>.*)$/)
    if (!match) throw new Error("expected hh:mm:ss")
    const ref = referenceForTimeControl(messages);
    if (ref == null) throw new Error("no log messages have any times in them");
    const hh = parseInt(match.groups.hh);
    const mm = parseInt(match.groups.mm);
    const ss = parseInt(match.groups.ss);
    const ms = parseInt(match.groups.ms) || 0;
    let t = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hh, mm, ss, ms));
    if (!match.groups.rest) return t;
    const match2 = match.groups.rest.match(/^ \((?<plusminus>\+|-)?(?<days>\d+) ?(d|day|days)?\)$/);
    if (!match2) throw new Error("expected hh:mm:ss (+Ndays)");
    const plusDays = match2.groups.days * (match2.groups.plusminus == "+" ? 1 : -1);
    t.setUTCDate(t.getUTCDate() + plusDays)
    return t;
  } else if (time.charAt(0) == "+" || time.charAt(0) == "-") {
    if (relativeTo == null) throw new Error("need start for +N relative times");
    const match = time.match(
      /^(\+|-)(\d+) ?(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours)$/
    );
    if (!match) throw new Error("expected +N h|m|s");
    const n = parseInt(match[2]) * (time.charAt() == "+" ? 1 : -1);
    const unit = match[3].charAt(0);
    const r = new Date(relativeTo.getTime());
    if (unit == "s") r.setUTCSeconds(r.getUTCSeconds() + n);
    else if (unit == "m") r.setUTCMinutes(r.getUTCMinutes() + n);
    else if (unit == "h") r.setUTCHours(r.getUTCHours() + n);
    else throw new Error("unexpected time unit");
    return r;
  } else {
    throw new Error(`expected hh:mm:ss or +N h|m|s`);
  }
}

/** FNB-1a hash - given a string, produces a positive number.
 * From https://gist.github.com/vaiorabbit/5657561
 */
 function hash(s) {
let hash = 0x811c9dc5;
  for (let i=0; i<s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash);
}

/** Given a string like "id + title", this returns a function which
 * takes message 'm' and returns the result of evaluating the string
 * If there are errors constructing the function, e.g. parse errors,
 * they're not reported immediately; instead we return a function which
 * will throw that error. In this way parse errors are produced lazily
 * just like evaluation errors.
 * Security notice: these strings come from the URL query string, which is
 * an untrusted source -- imagine if the string were 'new XMLHttpRequest().put()'.
 * We're going to restrict the string from accessing 'this' nor any top-level
 * symbols other than a whitelist. https://stackoverflow.com/a/69750236
 */
function make_fn(expr) {
  const whitelist = ['Math', 'Array', 'String', 'JSON']; // Warning: not 'Function'
  let scope = {};
  for (let obj = window; obj; obj = Object.getPrototypeOf(obj)) {
    Object.getOwnPropertyNames(obj).forEach(name => scope[name] = undefined);
  }
  whitelist.forEach(name => scope[name] = window[name]);
  try {
    const fn = Function(
      "scope",
      "log",
      "message",
      "tags",
      "time",
      "line",
      "title",
      "body",
      "id",
      "filename",
      "json",
      "with (scope) return " + expr
    ).bind({});
    return (m) =>
      fn(
        scope,
        m.log,
        m.message,
        m.tags,
        m.time,
        m.line,
        m.title,
        m.body,
        m.id,
        m.filename,
        m.json
      );
  } catch (e) {
    return (m) => {
      throw e;
    };
  }
}

/** Given hue, saturation, lightness each in range [0..1],
 * returns an rgb string "#rrggbb" for that color.
 */
function hsl(h, s, l) {
  let r, g, b;
  if (s == 0) {
    r = g = b = l;
  } else {
    const f = (p, q, t) => {
      if (t < 0) t += 1;
      else if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      else if (t < 1 / 2) return q;
      else if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      else return p;
    };
    let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    let p = 2 * l - q;
    r = f(p, q, h + 1 / 3);
    g = f(p, q, h);
    b = f(p, q, h - 1 / 3);
  }
  const x = (i) => {
    let s = Math.round(i * 255).toString(16);
    while (s.length < 2) s = "0" + s;
    if (s.length > 2) s = "FF";
    return s;
  };
  return `#${x(r)}${x(g)}${x(b)}`;
}
