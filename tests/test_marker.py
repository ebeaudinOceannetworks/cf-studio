import glob
import os

FOLDER_TO_TEST = "/Users/ebeaudin/Desktop/CF/data-app-test"

cor_files = glob.glob(os.path.join(FOLDER_TO_TEST, "**", "*.cor"), recursive=True) + \
            glob.glob(os.path.join(FOLDER_TO_TEST, "**", "*.COR"), recursive=True)

print(f"Total .cor files found: {len(cor_files)}")

samples = []

for f in cor_files:
    fname = os.path.basename(f)
    st_name = "MISSING"
    lat, lon = "MISSING", "MISSING"
    
    with open(f, "r", encoding="utf-8", errors="ignore") as file:
        for line in file:
            line_str = line.strip()
            if line_str.startswith("Station name:"):
                st_name = line_str.split(":", 1)[1].strip()
            elif line_str.startswith("LatitudeCastStart:"):
                lat = line_str.split(":", 1)[1].split(";")[0].strip()
            elif line_str.startswith("LongitudeCastStart:"):
                lon = line_str.split(":", 1)[1].split(";")[0].strip()
            elif "------ BEGIN DATA ------" in line_str:
                break

    if len(samples) < 10:
        samples.append((fname, st_name, lat, lon))

print("\nParsed ONC Top Headers:")
for s in samples:
    print(f"File: {s[0]}\n  Station: {s[1]} | Lat: {s[2]} | Lon: {s[3]}")