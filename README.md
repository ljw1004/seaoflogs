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
* Technique: use `text: line` to see the most informative first line of messages
* Technique: use `filter: title.includes('/did')` to get didOpen and didChange messages
* Technique: use `text: (json?.textDocument ? filename + '#' + json.textDocument.version : '')` to get filename and version if present
https://user-images.githubusercontent.com/3316258/139136151-7dd04b3c-ef22-4f90-9be4-d7e3cb698b59.mp4

## Demo 3: multiple logs
* [Try it - demo.html](https://ljw1004.github.io/seaoflogs/demo.html?text=log.includes%28%27rust%27%29+%3F+line+%3A+title&color=log&log_client=right). This exploration is to see if the VSCode extension had any activity during the LSP message exchange.
* Technique: Left/Center/Right drop-downs to send one log to the left and the other to the right
* Technique: use `text: log.includes('rust') ? line : title` to render messages according to which log they're from
* Technique: use `color: log` to color by log
https://user-images.githubusercontent.com/3316258/139136158-6f4049be-d653-4bce-a477-ca84a7a4a3f1.mp4

## What kind of logs can be parsed

"Sea of logs" aims to be relaxed about what it can accept, but including at least LSP. Here are examples.
```
[Trace - 9:43:06 PM] Sending request 'initialize - (0)'.
Params: {
    "processId": 21953
}
[Trace - 9:43:06 PM] Received response 'initialize - (0)' in 5ms.
Result: {
    "capabilities": null
}

[DEBUG][10/26/2021, 9:43:06 PM]: Extension version: 0.2.792
[INFO][10/26/2021, 9:43:06 PM]: Using configuration {cargoRunner: null}
```
The rules for parsing a logfile into messages:
* A `message` is defined as one or more lines where the first line starts with one or more `tags` in square brackets
*  `time` is a best effort to parse a timestamp out of those tags.
*  `line` is what comes after tags, and we make best effort to split into `title` and `body`
*  `json` is best effort to find a json object or array starting at the end of the first line or one the second line

Parsing is still a work in progress. If you have a reasonable log format that can't be parsed, we should figure out a generalization of your log format and change sea-of-logs to parse it.

## How to distribute

"Sea of logs" can be used in two ways.

**Normal**. Launch sea-of-logs at https://ljw1004.github.io/seaoflogs/, and click the Load button to explore your logs. As you explore, by interactively setting `filter` and `text` expressions, they are included in the URL. This way you can bookmark the URL to remember where you left off. *NOTE: the URL does *not* include the content of logfiles; it only includes their filenames. When you visit your bookmark, you'll have to re-load whatever logfiles you want.*

**Self-contained**. You can package up a single self-contained html file that includes both the sea-of-logs tool, and one or more logfiles. Indeed the demos on this page are all self-contained. You might keep that self-contained file on your hard disk, or you might place it on web-page (e.g. linked from an issue-tracker on github). *If you share a self-contained bookmark with colleagues, they'll get both the content of the logs and your filters on it. Note that LSP traces usually contain the source code that the user was editing: only share self-contained files if you're allowed to share the user's source code.*
```
# Construct a self-contained logfile, by concatenating sea-of-logs itself
# with whatever logs you want.

$ cp seaoflogs/index.html mylog.html
$ tail -n +1 ~/logs/*  >> mylog.html
```

"Sea of logs" uses the standard MIT license to support the self-contained distribution model.


## Threat model

*Scenario: my customers have sent me their confidential logfiles. I want to be able to analyze them but I have to be sure that I won't leak their data. I'm specifically not willing to upload the logs to some online log-visualizing website.* In this case you can download a copy of sea-of-logs index.html to your hard disk, audit it to confirm that it makes no network access, open the local file in your web-browser, and load files into it.

*Scenario: my customer sent me a logfile that I don't trust. I want to visualize it but me sure it won't harm me.* I guess you benefit from sea-of-logs already running in the browser sandbox. You could try audit the code to see that logfiles are only ever loaded as data, never executed - but this is html so I suppose it's hard to be sure there aren't sneaky loopholes.

*Scenario: someone uploaded or bookmarked a self-contained sea-of-logs file; is it safe to visit if I don't trust that person?* If they uploaded a self-contained sea-of-logs then they could have added malicious code, and you'd trust this just the same as trusting any random website. The bookmark URL contains javascript that will be executed on your machine. You can see for yourself by sticking an `alert('oops')` call inside one of the fields in sea-of-logs and seeing that your tab gets alert-bombed. If you don't trust someone, get raw logfiles from them rather than self-contained sea-of-logs.


## Contributing

No idea. I've never yet build any projects where people were excited enough to contribute. If you're interested, go ahead!