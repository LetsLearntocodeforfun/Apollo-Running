/**
 * Unit tests for the XML layer of activity file import: the tolerant XML
 * scanner and value helpers (services/fileImport/xml.ts), and the GPX / TCX
 * parsers built on it (gpx.ts, tcx.ts).
 *
 * Covers: namespaces / prefixes, attribute order and quoting, CDATA,
 * entities, comments, DOCTYPEs, broken and truncated markup, timestamps,
 * text encodings, Garmin / Strava / generic GPX flavours (extensions, sport
 * types, routes without timestamps, multiple tracks) and TCX laps, totals,
 * trackpoint extensions, multisport sessions and courses.
 */

import { describe, it, expect } from 'vitest';
import { decodeEntities, decodeXmlBytes, parseXmlNumber, parseXmlTime, scanXml } from '@/services/fileImport/xml';
import { parseGpx } from '@/services/fileImport/gpx';
import { parseTcx } from '@/services/fileImport/tcx';

// ── XML scanner ───────────────────────────────────────────────────────────────

describe('scanXml', () => {
  function events(xml: string): string[] {
    const out: string[] = [];
    scanXml(xml, {
      open: (name, attrs) => out.push(`open ${name} ${JSON.stringify(attrs)}`),
      text: (text, path) => out.push(`text ${path.join('/')} ${text}`),
      close: (name) => out.push(`close ${name}`),
    });
    return out;
  }

  it('reports lower-cased local names, attributes in any quoting, entities and CDATA', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "v">]><!-- a > comment -->'
      + '<a:Root B="1" c=\'2\'><b>x &amp; y &#233; &#x41; &unknown;</b><c/><d><![CDATA[<raw> & stuff]]></d></a:Root>';
    expect(events(xml)).toEqual([
      'open root {"b":"1","c":"2"}',
      'open b {}',
      'text root/b x & y é A &unknown;',
      'close b',
      'open c {}',
      'close c',
      'open d {}',
      'text root/d <raw> & stuff',
      'close d',
      'close root',
    ]);
  });

  it('repairs mismatched end tags and closes a truncated document', () => {
    expect(events('<root><e><f>unclosed</e><g x="a>b">trunc')).toEqual([
      'open root {}',
      'open e {}',
      'open f {}',
      'text root/e/f unclosed',
      'close f',
      'close e',
      'open g {"x":"a>b"}',
      'text root/g trunc',
      'close g',
      'close root',
    ]);
  });

  it('ignores whitespace-only text, stray end tags and a stray "<"', () => {
    expect(events('  \n<r>\n  <v>1 < 2</v>\n</x></r>')).toEqual([
      'open r {}',
      'open v {}',
      'text r/v 1 < 2',
      'close v',
      'close r',
    ]);
  });

  it('decodes entities', () => {
    expect(decodeEntities('a &lt;b&gt; &quot;c&quot; &apos;d&apos; &#128512;')).toBe('a <b> "c" \'d\' 😀');
    expect(decodeEntities('no entities')).toBe('no entities');
  });
});

describe('XML values', () => {
  const t = Date.UTC(2024, 2, 10, 13, 0, 0);

  it('parses timestamps with Z, offsets, fractions, a space separator or no zone (UTC)', () => {
    expect(parseXmlTime('2024-03-10T13:00:00Z')).toBe(t);
    expect(parseXmlTime(' 2024-03-10T15:00:00+02:00 ')).toBe(t);
    expect(parseXmlTime('2024-03-10T08:00:00-0500')).toBe(t);
    expect(parseXmlTime('2024-03-10 13:00:00')).toBe(t);
    expect(parseXmlTime('2024-03-10T13:00:00')).toBe(t);
    expect(parseXmlTime('2024-03-10T13:00:00.123456Z')).toBe(t + 123);
    expect(parseXmlTime('')).toBeNaN();
    expect(parseXmlTime('yesterday')).toBeNaN();
  });

  it('parses numbers, tolerating a decimal comma', () => {
    expect(parseXmlNumber(' 12.5 ')).toBe(12.5);
    expect(parseXmlNumber('12,5')).toBe(12.5);
    expect(parseXmlNumber('-3')).toBe(-3);
    expect(parseXmlNumber('')).toBeUndefined();
    expect(parseXmlNumber('abc')).toBeUndefined();
  });

  it('decodes UTF-8, UTF-16 (BOM or NUL pattern) and declared single-byte encodings', () => {
    const utf8 = new TextEncoder().encode('<a>café</a>');
    expect(decodeXmlBytes(utf8)).toBe('<a>café</a>');

    const utf16 = (s: string, littleEndian: boolean, bom: boolean): Uint8Array => {
      const out: number[] = bom ? (littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
      for (const ch of s) {
        const c = ch.charCodeAt(0);
        out.push(...(littleEndian ? [c & 0xff, c >> 8] : [c >> 8, c & 0xff]));
      }
      return new Uint8Array(out);
    };
    expect(decodeXmlBytes(utf16('<a>é</a>', true, true))).toBe('<a>é</a>');
    expect(decodeXmlBytes(utf16('<a>é</a>', false, true))).toBe('<a>é</a>');
    expect(decodeXmlBytes(utf16('<a>é</a>', true, false))).toBe('<a>é</a>');

    const latin = '<?xml version="1.0" encoding="ISO-8859-1"?><a>caf\xe9 \x80</a>';
    const bytes = new Uint8Array(Array.from(latin, (c) => c.charCodeAt(0)));
    expect(decodeXmlBytes(bytes)).toBe('<?xml version="1.0" encoding="ISO-8859-1"?><a>café €</a>');
  });
});

// ── GPX ───────────────────────────────────────────────────────────────────────

const GARMIN_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="Garmin Connect" version="1.1" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
  xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v2">
  <metadata><link href="connect.garmin.com"><text>Garmin Connect</text></link><time>2024-03-10T12:59:00.000Z</time></metadata>
  <trk>
    <name><![CDATA[Chicago <Easy> Running]]></name>
    <type>running</type>
    <trkseg>
      <trkpt lat="41.88" lon="-87.63"><ele>180.0</ele><time>2024-03-10T13:00:00.000Z</time>
        <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr><gpxtpx:cad>80</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions>
      </trkpt>
      <trkpt lon='-87.6299' lat='41.8801'><ele>181.5</ele><time>2024-03-10T13:00:05Z</time>
        <extensions><ns3:TrackPointExtension><ns3:hr>125</ns3:hr><ns3:cad>82</ns3:cad><ns3:speed>2.9</ns3:speed></ns3:TrackPointExtension></extensions>
      </trkpt>
      <trkpt lat="41.8802" lon="-87.6298"><ele>182</ele>
        <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>126</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
      </trkpt>
      <trkpt lat="41.8803" lon="-87.6297"><time>2024-03-10T13:00:10.250Z</time><extensions><power>250</power></extensions></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('parseGpx', () => {
  it('reads a Garmin Connect GPX: positions, elevation, extensions with any prefix, name, sport, origin', () => {
    const [a, ...rest] = parseGpx(GARMIN_GPX);
    expect(rest).toHaveLength(0);
    expect(a.type).toBe('Run');
    expect(a.name).toBe('Chicago <Easy> Running');
    expect(a.origin).toBe('GARMIN');
    expect(a.startTime).toBe(Date.UTC(2024, 2, 10, 13, 0, 0));
    expect(a.laps).toEqual([]);
    expect(a.totals).toEqual({});
    // The point without <time> is skipped.
    expect(a.samples).toEqual([
      { time: Date.UTC(2024, 2, 10, 13, 0, 0), lat: 41.88, lng: -87.63, altitude: 180, heartRate: 120, cadence: 80 },
      { time: Date.UTC(2024, 2, 10, 13, 0, 5), lat: 41.8801, lng: -87.6299, altitude: 181.5, heartRate: 125, cadence: 82, speed: 2.9 },
      { time: Date.UTC(2024, 2, 10, 13, 0, 10) + 250, lat: 41.8803, lng: -87.6297, power: 250 },
    ]);
  });

  it("maps Strava's numeric <type> codes and creator", () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX Android" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
 <metadata><time>2023-07-01T10:00:00Z</time></metadata>
 <trk><name>Lunch Ride</name><type>1</type><trkseg>
  <trkpt lat="45.0" lon="7.0"><ele>200</ele><time>2023-07-01T10:00:00Z</time></trkpt>
  <trkpt lat="45.001" lon="7.0"><ele>201</ele><time>2023-07-01T10:00:10Z</time></trkpt>
 </trkseg></trk>
</gpx>`;
    const [a] = parseGpx(gpx);
    expect(a.type).toBe('Ride');
    expect(a.origin).toBe('STRAVA');
    expect(a.name).toBe('Lunch Ride');
    expect(parseGpx(gpx.replace('<type>1</type>', '<type>9</type>'))[0].type).toBe('Run');
    expect(parseGpx(gpx.replace('<type>1</type>', '<type>Run</type>'))[0].type).toBe('Run');
  });

  it('returns nothing for routes and tracks without timestamps', () => {
    const route = '<gpx><rte><rtept lat="1" lon="2"><time>2020-01-01T00:00:00Z</time></rtept></rte>'
      + '<wpt lat="1" lon="2"><time>2020-01-01T00:00:00Z</time></wpt>'
      + '<trk><trkseg><trkpt lat="1" lon="2"><ele>3</ele></trkpt><trkpt lat="1.1" lon="2"/></trkseg></trk></gpx>';
    expect(parseGpx(route)).toEqual([]);
    expect(parseGpx('not xml at all')).toEqual([]);
  });

  it('splits tracks, sorts points, reads indoor types and sport words in track names', () => {
    const gpx = `<gpx creator="Some App">
<trk><name>Running 6/15/19 7:35 am</name><trkseg>
  <trkpt lat="1" lon="1"><time>2019-06-15T11:35:10Z</time></trkpt>
  <trkpt lat="1" lon="1.0001"><time>2019-06-15T11:35:00Z</time></trkpt>
</trkseg></trk>
<trk><type>treadmill_running</type><trkseg>
  <trkpt><time>2019-06-16T11:00:00Z</time><extensions><heartrate>130</heartrate></extensions></trkpt>
  <trkpt><time>2019-06-16T11:00:01Z</time><extensions><heartrate>131</heartrate><cadence>88</cadence></extensions></trkpt>
</trkseg></trk>
<trk><name>Just one point</name><trkseg><trkpt lat="1" lon="1"><time>2019-06-17T11:00:00Z</time></trkpt></trkseg></trk>
</gpx>`;
    const list = parseGpx(gpx);
    expect(list).toHaveLength(2);
    expect(list[0].type).toBe('Run');
    expect(list[0].origin).toBeUndefined();
    expect(list[0].startTime).toBe(Date.UTC(2019, 5, 15, 11, 35, 0));
    expect(list[0].samples.map((s) => s.lng)).toEqual([1.0001, 1]);
    expect(list[1].type).toBe('Run');
    expect(list[1].trainer).toBe(true);
    expect(list[1].samples[1]).toEqual({ time: Date.UTC(2019, 5, 16, 11, 0, 1), heartRate: 131, cadence: 88 });
    expect(list[1].samples[0].lat).toBeUndefined();
  });

  it('leaves the type empty when nothing names the sport', () => {
    const gpx = '<gpx><trk><name>Route 2020-01-01 7:30am</name><trkseg>'
      + '<trkpt lat="1" lon="1"><time>2020-01-01T07:30:00Z</time></trkpt>'
      + '<trkpt lat="1" lon="1.001"><time>2020-01-01T07:31:00Z</time></trkpt></trkseg></trk></gpx>';
    expect(parseGpx(gpx)[0].type).toBe('');
  });
});

// ── TCX ───────────────────────────────────────────────────────────────────────

/** Garmin Connect TCX, with the leading whitespace Strava's TCX exports are known for. */
const GARMIN_TCX = `          <?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"
  xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Activities>
    <Activity Sport="Running">
      <Id>2024-05-01T11:00:00.000Z</Id>
      <Lap StartTime="2024-05-01T11:00:00.000Z">
        <TotalTimeSeconds>300.0</TotalTimeSeconds>
        <DistanceMeters>1000.0</DistanceMeters>
        <MaximumSpeed>3.6</MaximumSpeed>
        <Calories>70</Calories>
        <AverageHeartRateBpm><Value>140</Value></AverageHeartRateBpm>
        <MaximumHeartRateBpm><Value>150</Value></MaximumHeartRateBpm>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
          <Trackpoint>
            <Time>2024-05-01T11:00:00.000Z</Time>
            <Position><LatitudeDegrees>51.5</LatitudeDegrees><LongitudeDegrees>-0.12</LongitudeDegrees></Position>
            <AltitudeMeters>10.0</AltitudeMeters>
            <DistanceMeters>0.0</DistanceMeters>
            <HeartRateBpm><Value>130</Value></HeartRateBpm>
            <Extensions><ns3:TPX><ns3:Speed>3.2</ns3:Speed><ns3:RunCadence>85</ns3:RunCadence></ns3:TPX></Extensions>
          </Trackpoint>
          <Trackpoint>
            <Time>2024-05-01T11:05:00.000Z</Time>
            <Position><LatitudeDegrees>51.509</LatitudeDegrees><LongitudeDegrees>-0.12</LongitudeDegrees></Position>
            <AltitudeMeters>12.0</AltitudeMeters>
            <DistanceMeters>1000.0</DistanceMeters>
            <HeartRateBpm><Value>145</Value></HeartRateBpm>
          </Trackpoint>
        </Track>
        <Extensions><ns3:LX><ns3:AvgSpeed>3.33</ns3:AvgSpeed><ns3:AvgRunCadence>86</ns3:AvgRunCadence></ns3:LX></Extensions>
      </Lap>
      <Lap StartTime="2024-05-01T11:06:00.000Z">
        <TotalTimeSeconds>600</TotalTimeSeconds>
        <DistanceMeters>2000</DistanceMeters>
        <Calories>140</Calories>
        <AverageHeartRateBpm><Value>155</Value></AverageHeartRateBpm>
        <MaximumHeartRateBpm><Value>165</Value></MaximumHeartRateBpm>
        <Cadence>88</Cadence>
        <Track>
          <Trackpoint><Time>2024-05-01T11:06:00Z</Time><DistanceMeters>1000</DistanceMeters><HeartRateBpm><Value>150</Value></HeartRateBpm><Cadence>90</Cadence></Trackpoint>
          <Trackpoint><Time>2024-05-01T11:16:00Z</Time><DistanceMeters>3000</DistanceMeters></Trackpoint>
        </Track>
      </Lap>
      <Creator xsi:type="Device_t">
        <Name>Forerunner 965</Name>
        <UnitId>1</UnitId>
        <Version><VersionMajor>19</VersionMajor><VersionMinor>18</VersionMinor></Version>
      </Creator>
    </Activity>
  </Activities>
  <Author xsi:type="Application_t"><Name>Connect Api</Name></Author>
</TrainingCenterDatabase>`;

describe('parseTcx', () => {
  it('reads activity, laps, trackpoints, TPX / LX extensions and the device', () => {
    const [a, ...rest] = parseTcx(GARMIN_TCX);
    expect(rest).toHaveLength(0);
    expect(a.type).toBe('Run');
    expect(a.startTime).toBe(Date.UTC(2024, 4, 1, 11, 0, 0));
    expect(a.device).toBe('Forerunner 965');
    expect(a.origin).toBe('GARMIN');

    expect(a.samples).toHaveLength(4);
    expect(a.samples[0]).toEqual({
      time: Date.UTC(2024, 4, 1, 11, 0, 0), lat: 51.5, lng: -0.12, altitude: 10, distance: 0,
      heartRate: 130, speed: 3.2, cadence: 85,
    });
    expect(a.samples[2]).toEqual({ time: Date.UTC(2024, 4, 1, 11, 6, 0), distance: 1000, heartRate: 150, cadence: 90 });

    expect(a.laps).toHaveLength(2);
    expect(a.laps[0]).toEqual({
      startTime: Date.UTC(2024, 4, 1, 11, 0, 0),
      elapsedSec: 360, // until the next lap started (a one-minute pause)
      movingSec: 300,
      distance: 1000,
      avgSpeed: 3.33,
      maxSpeed: 3.6,
      avgHeartRate: 140,
      maxHeartRate: 150,
      avgCadence: 86,
    });
    expect(a.laps[1].elapsedSec).toBe(600);
    expect(a.laps[1].avgSpeed).toBeCloseTo(2000 / 600, 6);
    expect(a.laps[1].avgCadence).toBe(88);

    expect(a.totals).toEqual({
      movingSec: 900,
      distance: 3000,
      calories: 210,
      avgHeartRate: 150, // weighted by lap timer time
      maxHeartRate: 165,
      avgCadence: 87.3,
      maxSpeed: 3.6,
    });
  });

  it('reads every leg of a multisport session, lap-only activities and ignores courses', () => {
    const tcx = `<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <MultiSportSession>
      <Id>2024-06-01T07:00:00Z</Id>
      <FirstSport>
        <Activity Sport="Biking"><Id>2024-06-01T07:00:00Z</Id>
          <Lap StartTime="2024-06-01T07:00:00Z"><TotalTimeSeconds>3600</TotalTimeSeconds><DistanceMeters>30000</DistanceMeters><Cadence>90</Cadence>
            <Extensions><LX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><AvgWatts>200</AvgWatts></LX></Extensions></Lap>
        </Activity>
      </FirstSport>
      <NextSport>
        <Transition StartTime="2024-06-01T08:00:00Z"><TotalTimeSeconds>120</TotalTimeSeconds><DistanceMeters>100</DistanceMeters></Transition>
        <Activity Sport="Running"><Id>2024-06-01T08:02:00Z</Id>
          <Lap StartTime="2024-06-01T08:02:00Z"><TotalTimeSeconds>1800</TotalTimeSeconds><DistanceMeters>5000</DistanceMeters></Lap>
        </Activity>
      </NextSport>
    </MultiSportSession>
    <Activity Sport="Other"><Id>2024-06-02T07:00:00Z</Id>
      <Lap StartTime="2024-06-02T07:00:00Z"><TotalTimeSeconds>1200</TotalTimeSeconds><DistanceMeters>0</DistanceMeters></Lap>
    </Activity>
  </Activities>
  <Courses><Course><Name>My course</Name><Lap><TotalTimeSeconds>100</TotalTimeSeconds></Lap>
    <Track><Trackpoint><Time>2024-01-01T00:00:00Z</Time></Trackpoint></Track></Course></Courses>
</TrainingCenterDatabase>`;
    const list = parseTcx(tcx);
    expect(list.map((a) => a.type)).toEqual(['Ride', 'Run', 'Workout']);
    expect(list[0].samples).toEqual([]);
    expect(list[0].totals).toEqual({ movingSec: 3600, distance: 30000, avgCadence: 90, avgPower: 200, elapsedSec: 3600 });
    expect(list[0].laps).toEqual([
      { startTime: Date.UTC(2024, 5, 1, 7, 0, 0), elapsedSec: 3600, movingSec: 3600, distance: 30000, avgSpeed: 30000 / 3600, avgCadence: 90 },
    ]);
    expect(list[1].startTime).toBe(Date.UTC(2024, 5, 1, 8, 2, 0));
    expect(list[1].totals).toMatchObject({ movingSec: 1800, distance: 5000, elapsedSec: 1800 });
    expect(list[2].totals.distance).toBeUndefined();
    expect(list[2].totals.movingSec).toBe(1200);
  });

  it('returns nothing for course-only files and non-TCX text', () => {
    expect(parseTcx('<TrainingCenterDatabase><Courses><Course><Name>x</Name></Course></Courses></TrainingCenterDatabase>')).toEqual([]);
    expect(parseTcx('')).toEqual([]);
  });
});
