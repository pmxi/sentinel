# Email Sentinel
> An intelligent email notification system to find what matters

## Problem

Many people, including me, receive LOTS OF EMAIL. Core life activities like
business, education, and job searching happen over email. However, email also
accumulates impersonal spam and mass emails, making it overwhelming to manage.

Common email clients offer functionality to mark emails as important, but it's
not very good. Gmail uses heuristics like how often you email a sender, open
rate, etc... [[1]](https://support.google.com/mail/answer/186543) to
categorize which email is important, which is only decent.

I want to be able to respond to important stuff fast, while not overwhelming
myself.

## Why use an LLM?

LLMs can intelligently classify emails and their behavior can be controlled
with plain English prompts. I want to be able to set custom rules to manage
their email that match my specific workflow - something existing filters
can't do.

## Solution

An app that reads all incoming emails. It will decide if it's important, and
send an appropriate notification. If it's junk it will move it to a junk
folder.

This app should be configurable to monitor many mailboxes simultaneously. For
example, for my personal use case, it will monitor my Purdue email and my
personal Gmail.

An LLM will do this task better than the traditional Bayesian filters. People
will also be able to adjust the classification criteria to their needs.

## Features

Email Sentinel uses Google's Gemini LLM to classify your emails. You configure
your mail accounts in a mailboxes.yaml file - both IMAP and Gmail API are
supported. The app polls your accounts regularly (every 60 seconds by default)
and sends notifications for important emails via Twilio SMS or Telegram. A
SQLite database tracks which emails have been processed to avoid duplicates.

## Installation

I recommend creating a Python virtual environment. This project was developed
and tested with Python 3.13.2 on macOS Sonoma with a M3 MacBook. No guarantees
are made for other environments. Then, install dependencies from the
requirements.txt file.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configuration

First, set up environment variables for API keys and system settings using
`.env.example` as a template.

Then, configure your email accounts in a `mailboxes.yaml` file. The file path
is specified via environment variable. See `config/mailboxes.example.yaml` for
a template.

## Roadmap

- Allow customizing classification rules. Options are to build a Web UI, or
  continue using the mailboxes.yaml config file.
- Support for different LLM providers (currently uses Gemini, but want to add
  OpenAI, Anthropic, etc.)