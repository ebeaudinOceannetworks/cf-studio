# Community Fishers Plot Studio

Local app for Community Fishers CTD casts: load a folder of casts in `.cor` format, and bathymetry files in `.tif` format (<100 MB each), pick stations on a map, visualize the data (transect, time series, profiles, etc), and export in PNG.

## Requirements

- Python 3.11+
- Node.js (npm) to build the dashboard

## Launch
Inside the `cf-studio` folder:

**Mac:** double-click `launch_mac.command`

**Windows:** double-click `launch_windows.bat`

## How to use

1. On the open Dashboard, you will be prompted for a folder that contains the CF cast data (`.cor` format). Click **Load folder**.
2. Click **Remember path** for the next time you use the dashboard.
3. **Explore** is the map and sampling calendar. Click a station; Shift-click to add more.
4. **Studio** is an interactive plotting tool. Click **Customize** to edit title, fontsize, colors, style, figure resolution, etc., on that same figure.
5. **Save figure** downloads the figure as you see it.


## Get Bathymetry Data

**West coast**

Command prompt example for Prince Rupert Port Authority:

`gdal_translate -projwin -130.541267 54.443444 -130.182607 54.148639 -projwin_srs EPSG:4326  'OpenFileGDB:"/vsizip//vsicurl/https://ftp.maps.canada.ca/pub/nrcan_rncan/Topography_Topographie/canada_west_coast_DEM-MNA_cote_ouest_canada/canada_west_coast_DEM_original.gdb.zip":WEST_COAST_DEM' prince_rupert_dem.tif`

