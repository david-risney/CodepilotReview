This project is a VSCode extension. It uses npm to build, test, run, package. This project is a VSCode extension to help developers perform manual code reviews using AI. This is not intended to automate code reviews, but help humans perform manual code reviews.



Scenarios:

&#x20;- User uses AI to write code and then wants to review the code before submitting it. Own AI review.

&#x20;- User manually writes code and then wants to review the code before submitting it. Own human review.

&#x20;- Other human uses AI to write code and the user needs to perform a human code review. Other AI review.

&#x20;- Other human manually writes code and the user needs to perform a human code review. Other human review.



Supported code review providers:

&#x20;- Local

&#x20;- Azure DevOps

&#x20;- GitHub

&#x20;- Chromium (https://chromium-review.googlesource.com)



Features:

&#x20;- PR table with generated missing info: Title, Brief description, Is the user needed (blocking, yes, interest, no), Priority, Relevant links (other PRs, bugs, ...)

&#x20;- PR table includes advanced filtering (since ADO doesn't support advanced searching).

&#x20;- See PR issues on top of a local repo (read/write) or the actual code in question (read-only)

&#x20;- chat - using knowledge base talk to copilot about the change

&#x20;- dependency partition - partition code change into logically related chunks. Order chunks in dependency tree and make it easy to review separately. (Strict partitioning is not required - some overlap is OK - but all code needs to be included in a chunk. The chunks don't need to be by file - different parts of a file may go to different chunks)

&#x20;- ownership partition - partition the code change into things you own and are required to review

&#x20;- custom partition - chat with AI about what criteria you want to partition up the code change (eg downstream v upstream)

&#x20;- code tour - Guided walkthrough of each part of each chunk of partition with inline description of why and how and next/prev buttons.

&#x20;- most common reviewers - use git history to find most common reviewers for files

review tools

&#x20;- run review tools: run tool(s) to produce list of potential code review issues

&#x20;- run tool potential issues has a 'really?' button, 'fix' button and a chat interface to ask copilot about it - potentially revise issue

&#x20;- run tool potential issue has TLDR sentence, followed by details including what command to run to see the issue

&#x20;- run tool potential issue allows user chooses which potential issues to actually open as review issues.

&#x20;- issues start in 'draft' and are unpublished

&#x20;- issues that are draft can be published to have them actually show on ADO, GitHub, Chromium

&#x20;- issues can be opened by user

&#x20;- run review tools include built in tools and custom tools

&#x20;- run review tool, built-in: historic code review - Use copilot prompt to the effect of based on previous changes and previous code review feedback in related files any issues?

&#x20;- run review tool, built-in: meta questions - Use copilot prompt to the effect of does it make sense to do this? Does it match the bug/task? Is the bug/task ready to be implemented? Are correct people involved in code review?

&#x20;- run review tool, custom review tool include a command, an optional post parse script, a declarative VSCode compile error parse language, give copilot example command lines or example output to generate compile error parse language and optional post parse script

&#x20;- run review tool, custom review prompt: runs provided user prompt, takes output and runs second built-in copilot query to reform the previous output into expected JSON



Design and implementation notes:

&#x20;- Pluggable interface implementation for code review provider so we can implement ADO, GH, Chromium, Local, and perhaps more in the future.

&#x20;- Support review tool configuration reading from multiple locations including %project%/.codepilotreview/config.json and \~/.codepilotreview/config.json and normal VSCode config file

&#x20;- Use vscode.comments.createCommentController and related APIs to have nice inline code review feedback. See https://code.visualstudio.com/api/extension-guides/overview, https://code.visualstudio.com/api/extension-guides/commenting-api, and 

https://github.com/microsoft/vscode-extension-samples/tree/main/comment-sample

&#x20;- Use VSCode extension best practices.

&#x20;- Write specs as markdown files in repo

&#x20;- Maintain a knowledge base as markdown files in repo. Update these with design decisions, archiatecture and design overview, other helpful context, information source documents, tool usage, gotchas and issue workarounds.

&#x20;- Maintain excellent tests and test coverage. Update tests whenever fixing bugs or creating new features.



