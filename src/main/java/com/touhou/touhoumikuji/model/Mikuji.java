package com.touhou.touhoumikuji.model;
import lombok.Data;
import java.util.List;

@Data
public class Mikuji {
    private int id;
    private String fortune;
    private String title;
    private String character;
    private String ability;
    private String mainText;
    private String image;
    private List<MikujiDetail> details;
}
