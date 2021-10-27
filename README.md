# Sea of logs
This is an interactive tool to visualize LSP traces and other logs.

[TODO: video demonstrations of usage scenarios]

## How to deploy

Option 1: Launch sea-of-logs at https://ljw1004.github.io/seaoflogs/ and load your logfiles manually.

Option 2: Bookmark your settings. As you set up filters/viewers within sea-of-logs, the URL bar will update. You can bookmark and visit the same URL later to pick up with the same filters/viewers, or share the URL with colleagues.

Option 3: Construct a self-contained sea-of-logs file. You might do this on your hard disk, or upload the self-contained sea-of-logs to a bug tracker so anyone working on the bug can interactively view the logs.
```
$ cp index.html mylog.html
$ tail -n +1 ~/logs/*  >> mylog.html
```

## Threat model

*Scenario: my customers have sent me their confidential logfiles. I want to be able to analyze them but I have to be sure that I won't leak their data. I'm specifically not willing to upload the logs to some online log-visualizing website.* In this case you can download a copy of sea-of-logs index.html to your hard disk, audit it to confirm that it makes no network access, open the local file in your web-browser, and load files into it.

*Scenario: my customer sent me a logfile that I don't trust. I want to visualize it but me sure it won't harm me.* I guess you benefit from sea-of-logs already running in the browser sandbox. You could try audit the code to see that logfiles are only ever loaded as data, never executed - but this is html so I suppose it's hard to be sure there aren't sneaky loopholes.

*Scenario: someone uploaded or bookmarked a self-contained sea-of-logs file; is it safe to visit if I don't trust that person?* If they uploaded a self-contained sea-of-logs then they could have added malicious code, and you'd trust this just the same as trusting any random website. The bookmark URL contains javascript that will be executed on your machine. You can see for yourself by sticking an `alert('oops')` call inside one of the fields in sea-of-logs and seeing that your tab gets alert-bombed. If you don't trust someone, get raw logfiles from them rather than self-contained sea-of-logs.
