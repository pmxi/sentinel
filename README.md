# `Email Sentinel` vision

Problem:

Many people, including me, receive LOTS OF EMAILS. Lots of very important
business like job searching happens over Email. However, email gets a lot of
junk and automated emails. I want to be able to respond to important stuff
fast, while not overwhelming myself.

I have an immediate personal need for this product.

Solution:

An app that reads ALL incoming emails. It will decide if it’s important, and
send an appropriate notification. If it’s junk it will move it to a junk
folder.

This app should be configurable to monitor many mailboxes simultaneously. For
example, for my personal use case, it will monitor my Purdue email and my
personal Gmail.

An LLM will do this task better than the traditional Bayesian filters. People
will also be able to adjust the classification criteria to their needs.

# "Sales pitch"

A traditional email provider like Gmail uses heuristics like how often you
email a sender, open rate, etc... to categorize which email is important which
is decent.

This system aims to build a more meaningful, customizable sorting using quickly
improving LLM tech.

# MVP spec

Process all new incoming emails to my Gmail inbox and categorize each one using
an LLM, taking action:

Important -> send a notification to my phone with a terse summary of the email
Normal -> no action: leave in inbox for me to read on my own time Junk -> move
to junk folder

Example criteria:

Criteria: if any of the following are satisfied: Important
* Addressed to me personally
* Not automated email
* Job interview offer
* Immigration related Junk
* Newsletter/updates from an org I don’t have a relationship with
* Apparent scam

An email is Normal if it does not satisfy the criteria for Important or Junk.

Non-goals:

Database to handle user accounts for multiple users.

# Setup instructions

I recommend creating a Python virtual environment. This project was developed
and tested with Python 3.13.2 on macOS Sonoma with a M3 MacBook. No guarantees
are made for other environments. Then, install dependencies from the
requirements.txt file.

python -m .venv source .venv/bin/activate pip install -r requirements.txt

System configuration: system configuration refers to necessary parameters for
the functioning of this program independent of the user, e.g. API keys
necessary for configuring the notification system. Use environment variables as
shown in .env.example.

User configuration: user configuration refers to necessary parameters for the
user to define their desired functionality specific to them, e.g. configuring
their own email accounts. User configuration is set with the mailboxes.yaml
file. Its path is given in an environment variable.

# Technical details and notes

Use Python, Gmail API I'm also supporting IMAP now. I probably should have
started with IMAP.

Python environment lives in .venv/




# TODOs



PERFORMANCE

Use asynchronous features for API calls.

Implement async/await for concurrent email processing



CODE QUALITY


Write unit tests for core functionality

Set up Git.

Pin the version for all packages in requirements.txt

Use a factory pattern with a base Notifier class to create notifiers.

Consolidate EmailData imports to use src/email/models.py consistently

Implement consistent error handling across email clients


Fix hardcoded "Junk" folder name in gmail/client.py

Add comprehensive type hints throughout codebase

Fix logging configuration split by module issue

Create shared base implementation for notifier formatting
