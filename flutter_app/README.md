# Gabo Flutter App

This folder contains a standalone Flutter implementation of the Gabo chat UI.
It is isolated from the existing static web assets so you can build and deploy
mobile apps without impacting the current site.

## Getting started

1. Install Flutter: https://docs.flutter.dev/get-started/install
2. From this directory, fetch dependencies:

```
flutter pub get
```

3. Run locally:

```
flutter run
```

## Build for release

```
flutter build apk
flutter build ios
```

The app currently ships a starter UI shell that mirrors the web layout and is
ready for API wiring.
