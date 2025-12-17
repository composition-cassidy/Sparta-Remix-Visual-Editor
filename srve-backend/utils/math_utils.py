from __future__ import annotations


def clamp(value: float, min_value: float, max_value: float) -> float:
    return max(min_value, min(max_value, value))


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def calculate_grid_cell(
    output_resolution: tuple[int, int],
    grid_size: tuple[int, int],
    cell_position: tuple[int, int],
    snap_subdivisions: int = 1,
) -> dict:
    """
    Calculate the position and size of a grid cell.

    Args:
        output_resolution: (width, height) of the output canvas
        grid_size: (columns, rows) of the grid
        cell_position: (col, row), 0-indexed position of the cell
        snap_subdivisions: number of subdivisions per cell (unused for integer positions)

    Returns:
        dict with x, y, width, height of the cell
    """
    output_width, output_height = output_resolution
    columns, rows = grid_size
    col, row = cell_position

    cell_width = output_width / columns
    cell_height = output_height / rows

    x = int(col * cell_width)
    y = int(row * cell_height)

    return {
        "x": x,
        "y": y,
        "width": int(cell_width),
        "height": int(cell_height),
    }


def calculate_subdivided_position(
    output_resolution: tuple[int, int],
    grid_size: tuple[int, int],
    cell_position: tuple[float, float],
    snap_subdivisions: int,
) -> dict:
    """
    Calculate position with subdivision snapping support.

    Args:
        output_resolution: (width, height) of the output canvas
        grid_size: (columns, rows) of the grid
        cell_position: (col, row), can be fractional for subdivisions (e.g., 0.5, 1.5)
        snap_subdivisions: number of subdivisions per cell for snapping

    Returns:
        dict with x, y, width, height of the cell
    """
    output_width, output_height = output_resolution
    columns, rows = grid_size
    col, row = cell_position

    cell_width = output_width / columns
    cell_height = output_height / rows

    if snap_subdivisions > 1:
        col = round(col * snap_subdivisions) / snap_subdivisions
        row = round(row * snap_subdivisions) / snap_subdivisions

    x = int(col * cell_width)
    y = int(row * cell_height)

    return {
        "x": x,
        "y": y,
        "width": int(cell_width),
        "height": int(cell_height),
        "snapped_col": col,
        "snapped_row": row,
    }


def fit_video_to_cell(
    video_resolution: tuple[int, int],
    cell_size: tuple[int, int],
    scale: float = 1.0,
) -> dict:
    """
    Calculate how to fit a video into a cell while maintaining aspect ratio.

    Args:
        video_resolution: (width, height) of the source video
        cell_size: (width, height) of the target cell
        scale: zoom factor (1.0 = fit to cell, >1.0 = zoom in)

    Returns:
        dict with:
        - scale_factor: the scaling factor applied to the video
        - offset_x: horizontal offset to center video in cell
        - offset_y: vertical offset to center video in cell
        - crop_rect: (x, y, width, height) if video exceeds cell bounds, else None
    """
    video_width, video_height = video_resolution
    cell_width, cell_height = cell_size

    video_aspect = video_width / video_height
    cell_aspect = cell_width / cell_height

    if video_aspect > cell_aspect:
        base_scale = cell_width / video_width
    else:
        base_scale = cell_height / video_height

    scale_factor = base_scale * scale

    scaled_width = video_width * scale_factor
    scaled_height = video_height * scale_factor

    offset_x = int((cell_width - scaled_width) / 2)
    offset_y = int((cell_height - scaled_height) / 2)

    crop_rect = None
    if scaled_width > cell_width or scaled_height > cell_height:
        crop_x = max(0, -offset_x)
        crop_y = max(0, -offset_y)
        crop_width = min(int(scaled_width), cell_width)
        crop_height = min(int(scaled_height), cell_height)
        crop_rect = (crop_x, crop_y, crop_width, crop_height)

    return {
        "scale_factor": scale_factor,
        "offset_x": offset_x,
        "offset_y": offset_y,
        "crop_rect": crop_rect,
    }
