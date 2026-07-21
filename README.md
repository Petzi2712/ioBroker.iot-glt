# IOT GLT – ioBroker Gebäudeleittechnik

IOT GLT ist ein responsiver ioBroker-Adapter für technische Gebäudevisualisierung, Betriebs- und Störmeldungen, Trends sowie Energie- und CO₂-Auswertungen. Der Adapter enthält ausschließlich JavaScript-Abhängigkeiten und eignet sich damit auch für aktuelle Raspberry-Pi-Systeme mit unterstützter Node.js-Version.

> Status: frühe Version `0.1.0`. Vor einem produktiven Einsatz sind Anlagen-, Sicherheits- und Ausfalltests in der Zielumgebung erforderlich.

## Funktionen

- Responsive Weboberfläche unter der ioBroker-IP und dem konfigurierten Port
- Frei konfigurierbares technisches Dashboard mit verschiebbaren und skalierbaren Kacheln
- Dashboard-Kacheln als Linie, Balken, Heatmap, Füllstand, Messinstrument, Tabelle oder Einzelwert
- Schmaler, aufklappbarer Split-Screen mit den GLT-Funktionsbereichen
- Default-Gastzugriff mit Leserechten
- Benutzerverwaltung mit rollen- und modulbezogenen Lese-/Schreibrechten
- Betriebs-, Warn- und Störmeldungen mit frei konfigurierbaren Datenpunktregeln
- Dynamische Anlagenbilder mit Hintergrundbildern und frei positionierbaren Einblendpunkten
- Analoge Einblendpunkte öffnen direkt die zugehörige Trendansicht
- Schreibbare digitale Datenpunkte können durch berechtigte Benutzer geschaltet werden
- Trendkurven als Linie, Stufe, Balken oder Heatmap inklusive Tooltips und mehrseitigem PDF-Export
- Energieberichte aus Zählerdifferenz, Summe oder Mittelwert
- Kostenberechnung über einen frei definierbaren kWh-Preis
- CO₂-Bilanzierung über einen frei definierbaren Emissionsfaktor
- Persistente Berichte und optionaler Versand über einen ioBroker-E-Mail-Adapter

## Installation aus GitHub

Im ioBroker-Adminbereich **Adapter → Adapter aus eigener URL installieren** öffnen und folgende URL eintragen:

```text
https://github.com/Petzi2712/ioBroker.iot-glt
```

Alternativ auf der ioBroker-Konsole:

```bash
iobroker url https://github.com/Petzi2712/ioBroker.iot-glt --host <HOSTNAME>
```

Nach der Installation eine Instanz von `iot-glt` anlegen. Der Standardport ist `8095`. Die Oberfläche ist anschließend erreichbar unter:

```text
http://<IOBROKER-IP>:8095
```

## Erster Start

Der Gastzugriff ist zunächst schreibgeschützt. Für die Administration gilt einmalig:

- Benutzer: `admin`
- Passwort: `iot-glt`

Beim ersten Login verlangt die Oberfläche ein neues Passwort mit mindestens zehn Zeichen. Ändere das Passwort unbedingt, bevor der Port außerhalb eines vertrauenswürdigen Netzes erreichbar gemacht wird.

## Adapterkonfiguration

| Einstellung | Standard | Zweck |
| --- | --- | --- |
| Bind-Adresse | `0.0.0.0` | Netzwerkadresse des integrierten Webservers |
| Port | `8095` | Port der GLT-Oberfläche |
| Gastzugriff | aktiv | Nicht angemeldete Benutzer dürfen freigegebene Module lesen |
| History-Instanz | `history.0` | Quelle für Trend- und Berichtsdaten |
| E-Mail-Instanz | leer | Optionaler Versand gespeicherter Berichte |
| VIS-Basisadresse | leer | Adresse des VIS-Webservers, beispielsweise `http://192.168.178.101:8082` |
| CO₂-Faktor | `0.38 kg/kWh` | Vorgabewert für neue Berichte |
| Währung | `EUR` | Darstellung der Energiekosten |

Für Trends muss der ausgewählte Datenpunkt in der konfigurierten History-Instanz aufgezeichnet werden.

## Lokale und dauerhafte Speicherung

Benutzer, Passwort-Hashes, Rechte, Anlagenbaum, Visualisierungen, Dashboard-Kacheln, Melderegeln, Berichte und Oberflächeneinstellungen werden ausschließlich im lokalen Instanz-Datenordner des ioBroker-Hosts gespeichert. Die Hauptdatei heißt `iot-glt-model.json`; vor dem Überschreiben wird zusätzlich `iot-glt-model.json.bak` angelegt. Damit bleiben die Daten bei Adapter-Neustarts und Updates erhalten und werden von einer regulären ioBroker-Sicherung des Datenverzeichnisses erfasst. Frühere Konfigurationen aus `iot-glt.0.data.config` werden beim ersten Start automatisch migriert.

## ioBroker-Integration

- Die Datenpunktauswahl liest den ioBroker-Objektbaum direkt über die Adapter-API.
- Aktuelle Zustände kommen aus der ioBroker-State-Datenbank.
- Historische Werte werden per `getHistory` aus der ausgewählten `history`- oder `influxdb`-Instanz gelesen.
- Schreibzugriffe sind nur bei GLT-Schreibrecht und `common.write=true` möglich.
- VIS-Ansichten werden über die im Anlagenbaum gespeicherte URL geladen. Für relative `/vis-2/...`-Links muss die VIS-Basisadresse konfiguriert sein.

## Sicherheit

- Passwörter werden mit `scrypt` und individuellen Salts gespeichert.
- Sitzungen verwenden zufällige HttpOnly-Cookies mit `SameSite=Strict`.
- Schreibzugriffe sind zusätzlich durch ein sitzungsgebundenes CSRF-Token geschützt.
- ioBroker-Datenpunkte werden nur geschrieben, wenn deren Objekt `common.write=true` ausweist.
- Das integrierte HTTP-Frontend ersetzt bei Zugriff über nicht vertrauenswürdige Netze keinen TLS-Reverse-Proxy.

Für externen Zugriff werden HTTPS, eine Firewall beziehungsweise VPN und eine restriktive Portfreigabe empfohlen.

## Entwicklung und Tests

```bash
npm install
npm test
```

Lizenz: MIT
