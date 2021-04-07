# Changelog

1.3.1

- Persist mails from Inbox which are not parsable

1.3.0

- Output mail header and date when processing mails
- Group mail processing output as tree

1.2.0

- Add automatic reconnection option
- Do not update the uid, if the processing failed due to some reason

1.1.1

- Do not wait for changes in Inbox, if not all mails were already scanned

1.1.0

- Support batch size for Spam- and Ham-Box
- Add default config
- Add log output to facilitate debugging

1.0.3

- Prevent mails from being learned as ham, if the spam score calculation failed
- Fix an assignment error in the openMailbox function

1.0.2

- Fix mailcounter. Make it start from 1.. instead of 0..

1.0.1

- Fix uid range bug for inbox tracking
- Improve log output for single mail processing
- Make maximum mail size configurable

1.0.0

- Initial release