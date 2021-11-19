# Sea of logs
"Sea of logs" is an interactive tool to visualize LSP traces and other logs.
* Try it out: https://ljw1004.github.io/seaoflogs/demo.html
* Load own logs: https://ljw1004.github.io/seaoflogs/

The target audience for sea-of-logs is software developers who write language-service backends for Visual Studio Code or other editors. You'll often want to look at the trace of messages sent between VSCode and the language-service to see what happened, when, and why. VSCode lets you gather traces (Preferences > Settings and search for 'trace', then view it in the Output window, and copy/paste/save it to disk). But these traces are so voluminous you need to explore - filter out some messages, look at only some parts of the json payload for others, and tie together requests with their responses.

*"Sea of logs" offers a way to explore logs which (1) is interactive, (2) lets you use the full expressivity of javascript to filter what you see.*

Often you'll have logs from several sources, e.g. the VSCode extension you wrote for your language, the LSP transcript itself, and logs produced by your backend language server. You might want to use cross-log identifiers to tie together, say, a client request with the server's logs about how it handled it.

*"Sea of logs" collates multiple logs by timestamp. It uses vertical space to indicate delays, and helps you filter by timerange.*


## Demo 1: exploring progress messages
* [Try it - demo.html](https://ljw1004.github.io/seaoflogs/demo.html?filter=title+%3D%3D+%27%24%2Fprogress%27&text=json.token+%2B+%27+%27+%2B+json.value.kind+%2B+%27+%27+%2B+%28json.value.title+%7C%7C+json.value.message+%7C%7C+%27%27%29&color=json.token&log_rust_analyzer=hide_left). This exploration is to find out what all the LSP progress messages are about.
* Technique: use `filter: title == '$/progress'` to look only at progress messages
* Technique: use `text: json.token + json.value.kind` to extract key parts from the json payload
* Technique: use `color: json.token` to see which messages are of interest

https://user-images.githubusercontent.com/3316258/139136139-e8b96f7b-d800-4393-a5d4-95681cf835c0.mp4

## Demo 2: look at cancellations
* [Try it - demo.html](https://ljw1004.github.io/seaoflogs/demo.html?filter=line.includes%28%27Request+failed%27%29+%7C%7C+title.includes%28%27%2Fdid%27%29&text=%28filename+%7C%7C+%27%27%29+%2B+%28json%3F.textDocument+%3F+%27%23%27+%2B+json.textDocument.version+%3A+%27%27%29+%2B+%27+%27+%2B+line&color=body.replace%28%2F%5E.*+Request+failed%3A+%28.*%29+%5C%28.*%24%2F%2C%27%241%27%29&log_rust_analyzer=hide_left). This exploration is to find out why we're getting failures.
* Technique: click on a timestamp and "set start" to filter out earlier messages
* Technique: click on a message to get "details", and use this as a reference while writing your filters.
* Technique: use `text: line` to see the most informative first line of messages
* Technique: use `filter: title.includes('/did')` to get didOpen and didChange messages
* Technique: use `text: (json?.textDocument ? filename + '#' + json.textDocument.version : '')` to get filename and version if present

https://user-images.githubusercontent.com/3316258/139136151-7dd04b3c-ef22-4f90-9be4-d7e3cb698b59.mp4

## Demo 3: multiple logs
* [Try it - demo.html](https://ljw1004.github.io/seaoflogs/demo.html?text=log.includes%28%27rust%27%29+%3F+line+%3A+title&color=log&log_client=right). This exploration is to see if the VSCode extension had any activity during the LSP message exchange.
* Technique: use `color: log` to color by log
* Technique: use `text: log.includes('rust') ? line : title` to render messages according to which log they're from
* Technique: Left/Center/Right drop-downs to send one log to the left and the other to the right

https://user-images.githubusercontent.com/3316258/139136158-6f4049be-d653-4bce-a477-ca84a7a4a3f1.mp4

## What kind of logs can be parsed

"Sea of logs" aims to be relaxed about what it can accept, including at least LSP traces. Here are examples of three logs that can all be parsed. Incidentally, all three logs (VSCode extension, LSP trace and backend) come from the same session -- see that `id` "53906" is shared by different logs.
```
==> lsp.txt <==
[Trace - 9:43:06 PM] Sending request 'initialize - (53906)'.
Params: {
    "processId": 21953
}
[Trace - 9:43:06 PM] Received response 'initialize - (53906)' in 5ms.
Result: {
    "capabilities": null
}

==> backend.txt <==
[2021-10-26 21:43:06.511] [master][#53906] Heap size: 0.000590G
[2021-10-26 21:43:07.669] [worker-1] Parsing post_ss1.parsing: 0.101390

==> extension.txt <==
[DEBUG][10/26/2021, 9:43:06 PM]: Extension version: 0.2.792
[INFO][10/26/2021, 9:43:06 PM]: Using configuration {cargoRunner: null}
```
The rules for parsing a logfile into messages:
* A `message` is defined as one or more lines where the first line starts with one or more `tags` in square brackets
* `time` is a best effort to parse a timestamp out of those tags.
* `line` is what comes after tags, and we make best effort to split into `title` and `body`
* `json` is best effort to find a json object or array starting at the end of the first line or on the second line
* `id` is best effort to extract an id from LSP Trace, or from a tag of the form [\#id].
* `filename` is best effort to extract a filename.

A limitation of LSP traces is that they lack dates; they have only times-of-day. Sea-of-logs will compensate by assuming that the LSP trace starts on the same day as another fully dated log, if present. Another limitation of LSP traces is that they lack milliseconds -- but at least sea-of-logs does parse and respect milliseconds from other logs.

Parsing is still a work in progress. If you have a reasonable log format that can't be parsed, we should figure out a generalization of your log format and change sea-of-logs to parse it.

## How to distribute

"Sea of logs" can be used in three ways.

**Normal**. Launch sea-of-logs at https://ljw1004.github.io/seaoflogs/, and click the Load button to explore your logs. As you explore, by interactively setting `filter` and `text` expressions, they are included in the URL. This way you can bookmark the URL to remember where you left off. *NOTE: the URL does *not* include the content of logfiles; it only includes their filenames. When you visit your bookmark, you'll have to re-load whatever logfiles you want.*

**Local install**. You can download the "seaoflogs/index.html" file for when you want to use the tool locally. It's entirely standalone and doesn't access the network.

**Self-contained**. You can package up a single self-contained html file that combines both the sea-of-logs tool and one or more logfiles. Indeed the demos on this page are all self-contained! You might keep that self-contained file on your hard disk, or you might place it on web-page (e.g. linked from an issue-tracker on github). *If you share a self-contained bookmark with colleagues, they'll get both the content of the logs and your filters on it. Note that LSP traces usually contain the source code that the user was editing: only share self-contained files if you're allowed to share the user's source code.*
```
# Make a self-contained html file by concatenating

$ cp seaoflogs/index.html mylog.html
$ tail -n +1 ~/logs/* | sed 's/-->/-- >/' >> mylog.html
```

"Sea of logs" uses the standard MIT license to allow this self-contained distribution model.


## Threat model

*Scenario: my customers have sent me their confidential logfiles. I want to be able to analyze them but I have to be sure that I won't leak their data. I'm specifically not willing to upload the logs to some online log-visualizing website.* In this case you can download a copy of sea-of-logs index.html to your hard disk, audit it to confirm that it makes no network access, open the local file in your web-browser, and load files into it.

*Scenario: my customer sent me a logfile that I don't trust. I want to visualize it but me sure it won't harm me.* I guess you benefit from sea-of-logs already running in the browser sandbox. You could try audit the code to see that logfiles are only ever loaded as data, never executed - but this is html so I suppose it's hard to be sure there aren't sneaky loopholes.

*Scenario: my customer sent me a logfile that I don't trust. Is it safe to construct and view a self-contained sea-of-logs?* In addition to the above, this also opens up concerns whether the self-contained file "breaks out" of just being a log stored inside an html comment. The construction technique `sed 's/-->/-- >/` prevents the log from breaking out of that html comment. Beyond that, there are the same risks as above.

*Scenario: someome sent me a malicious sea-of-logs bookmark. Can I click it?* Sea-of-logs bookmarks have the form `<url>?query=<executable_code>`, and the executable code is executed in the sea-of-logs page. Now if their bookmark takes you to an external site then the risk is no different from clicking on any random link to any random site, which we do all the time. If the bookmark directs you to a file:// url on your hard disk, and that file is seaoflogs.html, then the attacker's query string will be executed in the context of a local file on your hard disk. I don't know what protection browsers have against this. In addition to whatever protections the browser has, sea-of-logs provides its own secondary sandbox for that query-string, but I'm sure there are loopholes.

*Scenario: someone uploaded a malicious self-contained file. Can I click it?* If they uploaded a self-contained sea-of-logs then they could have added malicious code, and you'd trust this just the same as trusting any random website. If they ask you to download the file, it's the same as downloading any random html from the internet and opening it locally.

*Scenario: I want to host seaoflogs on my website. How can I be sure it won't be a vector for XSS attacks?* You could place seaoflogs in an `<iframe sandbox='allow-scripts' />`. This way it won't be able to make any network requests. However, seaoflogs uses the window.location query params to record
its settings and this isn't allowed in an iframe. As a workaround, you can set `<meta name="seaoflogs_params" content="id=...&text=..." />` to
tell the seaoflogs iframe which initial params it should use; later, whenever it wants its part of the window.location params to be changed, it'll request
this by `window.top.postMessage(newparams)` to which you'll have to respond.



## Contributing

No idea. I've never yet build any projects where people were excited enough to contribute. If you're interested, go ahead! Ideas:
* The code is particularly weak on html-layout at the moment. I tried to do it with flex-box in another branch but it became much slower on 4k+ logfiles. I don't know how to do better.
* I wonder if the entire message-renderer and svg-renderer could become lazy too, like the background-renderer is at the moment? Then it could handle vastly larger log-files.
* Are there other formats for LSP-traces that need to be accepted?
* If you have a logfile that can't be parsed, you could create an issue and paste the log and I'll see how to ingest it. Or contribute ingestion code yourself. The date-parsing code is particularly un-general.
* It's a shame that we have to ignore the date portion of timestamps to accomodate LSP. I can't see any way around it.