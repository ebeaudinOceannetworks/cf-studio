import os
import glob
import cf
import xarray as xr

DATA_DIR = os.path.expanduser("~/Desktop/CF/PRPA")  # Adjust path as needed

def test_global_concat(directory):
    cor_files = glob.glob(os.path.join(directory, "**", "*.cor"), recursive=True)
    print(f"Testing global concatenation of {len(cor_files)} files...")
    
    ds_list = []
    for f in cor_files:
        try:
            cast = cf.cor2xr(f, save=False)
            cast['Dissolved Oxygen'] = cf.compute_o2_mL_L(cast)
            
            # Test inserting each cast into the accumulator one by one
            if ds_list:
                _ = xr.concat([ds_list[-1], cast], dim="cast", join="outer")
            ds_list.append(cast)
            print(f"  [OK] {os.path.basename(f)}")
        except Exception as e:
            print(f"❌ FAILED AT FILE: {os.path.basename(f)}")
            print(f"   └── Error: {e}")
            break

if __name__ == "__main__":
    test_global_concat(DATA_DIR)